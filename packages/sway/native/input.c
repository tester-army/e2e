#define _GNU_SOURCE
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/file.h>
#include <linux/openat2.h>
#include <linux/fs.h>
#include <dirent.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include "virtual-keyboard-client.h"
#include "virtual-pointer-client.h"

static volatile sig_atomic_t interrupted;
static void interrupt(int signal_number) { (void)signal_number; interrupted = 1; }
static uint32_t clock_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000); }
static const char *wanted_seat;
static struct wl_display *display;
static struct wl_seat *seat;
static unsigned matches;
static struct zwp_virtual_keyboard_manager_v1 *keyboard_manager;
static struct zwlr_virtual_pointer_manager_v1 *pointer_manager;
static struct zwp_virtual_keyboard_v1 *keyboard;
static struct zwlr_virtual_pointer_v1 *pointer;
static bool key_down, pointer_down;
static uint32_t active_key, named_capabilities;
static unsigned modifiers_down;
static const uint32_t modifier_keys[] = { 42, 29, 56, 125 };
static struct xkb_context *xkb_context;
static struct xkb_keymap *base_map;
static int base_fd = -1, unicode_fd = -1;
static uint32_t base_size, base_modifiers[4], active_modifiers[4];
static bool unicode_active;
static uint32_t unicode_scalar;
static char socket_directory[4096];
struct key_entry { uint32_t code; uint32_t modifiers; };
static struct key_entry ascii_keys[128];
static void seat_capabilities(void *data, struct wl_seat *value, uint32_t capabilities) {
  (void)data; if (value == seat) named_capabilities = capabilities;
}
static void seat_name(void *data, struct wl_seat *value, const char *name) { (void)data; if (strcmp(name, wanted_seat) == 0) { seat = value; matches++; } }
static const struct wl_seat_listener seat_listener = { seat_capabilities, seat_name };
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  if (strcmp(interface, "wl_seat") == 0 && version >= 2) {
    struct wl_seat *value = wl_registry_bind(registry, name, &wl_seat_interface, version < 7 ? version : 7);
    wl_seat_add_listener(value, &seat_listener, NULL);
  } else if (strcmp(interface, "zwp_virtual_keyboard_manager_v1") == 0) keyboard_manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
  else if (strcmp(interface, "zwlr_virtual_pointer_manager_v1") == 0) pointer_manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name) { (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = { global, global_remove };

/* A supervisor owns descendants even if Tern forks a daemon/new session. It
 * writes identity before fork, and never uses names or the host process list. */
static bool process_info(pid_t pid, unsigned long long *start, pid_t *parent) {
  char path[64], value[4096]; snprintf(path,sizeof path,"/proc/%ld/stat",(long)pid);
  FILE *file=fopen(path,"r");if(!file)return false;
  if(!fgets(value,sizeof value,file)){fclose(file);return false;}fclose(file);
  char *fields=strrchr(value,')');if(!fields)return false;fields+=2;
  char *save=NULL,*field=strtok_r(fields," ",&save);unsigned index=0;
  while(field){if(index==1)*parent=(pid_t)strtol(field,NULL,10);if(index==19){*start=strtoull(field,NULL,10);return *start!=0;}field=strtok_r(NULL," ",&save);index++;}return false;
}
static void stop_descendants(pid_t parent, unsigned long long expected, bool force) {
  unsigned long long current;pid_t ignored;
  if(!process_info(parent,&current,&ignored)||current!=expected)return;
  char tasks_path[64]; snprintf(tasks_path, sizeof tasks_path, "/proc/%ld/task", (long)parent);
  DIR *tasks = opendir(tasks_path); if (!tasks) return;
  struct dirent *task;
  while ((task = readdir(tasks))) {
    if (task->d_name[0] == '.') continue;
    char path[384]; snprintf(path, sizeof path, "%s/%s/children", tasks_path, task->d_name);
    FILE *file = fopen(path, "r"); if (!file) continue;
    long child;
    while (fscanf(file, "%ld", &child) == 1) {
      unsigned long long before,after;pid_t ppid,after_parent;
      if(!process_info((pid_t)child,&before,&ppid)||ppid!=parent)continue;
      int pidfd = (int)syscall(SYS_pidfd_open, (pid_t)child, 0);if(pidfd<0)continue;
      if(!process_info((pid_t)child,&after,&after_parent)||before!=after||after_parent!=parent||!process_info(parent,&current,&ignored)||current!=expected){close(pidfd);continue;}
      stop_descendants((pid_t)child,before,force);
      struct pollfd pinned={pidfd,POLLIN,0};
      if(poll(&pinned,1,0)==0&&process_info((pid_t)child,&after,&after_parent)&&after==before&&after_parent==parent&&process_info(parent,&current,&ignored)&&current==expected) syscall(SYS_pidfd_send_signal,pidfd,force?SIGKILL:SIGTERM,NULL,0);
      close(pidfd);
    }
    fclose(file);
  }
  closedir(tasks);
}
/* Cleanup marks a directory closed under the same lock held across publish/fork.
 * A late supervisor must either publish before cleanup's scan or refuse to start. */
static int lifecycle_lock(const char *identity_path, bool close_lease) {
  char directory[4096];if(strlen(identity_path)>=sizeof directory)return -1;strcpy(directory,identity_path);
  char *slash=strrchr(directory,'/');if(!slash||slash==directory)return -1;*slash=0;
  int dir=open(directory,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(dir<0)return -1;
  struct stat owner;if(fstat(dir,&owner)<0||owner.st_uid!=getuid()||(owner.st_mode&077)!=0){close(dir);return -1;}
  int lock=openat(dir,".lifecycle.lock",O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC,0600);
  if(lock<0||flock(lock,LOCK_EX)<0){if(lock>=0)close(lock);close(dir);return -1;}
  if(close_lease){int marker=openat(dir,".closing",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(marker<0&&errno!=EEXIST){close(lock);close(dir);return -1;}if(marker>=0){fsync(marker);close(marker);}fsync(dir);}
  else if(faccessat(dir,".closing",F_OK,AT_SYMLINK_NOFOLLOW)==0){close(lock);close(dir);return -1;}
  close(dir);return lock;
}
/* Pin every namespace before any entry. The second generation check closes
 * proc-name reuse; nsenter receives inherited descriptors, never --target. */
static int enter_namespaces(int argc,char **argv,int at) {
  if(argc<at+4)return 2;
  char *end;long pid=strtol(argv[at],&end,10);if(*end||pid<=0||pid>0x7fffffff)return 2;
  unsigned long long before,after;pid_t parent;
  if(!process_info((pid_t)pid,&before,&parent)||before!=strtoull(argv[at+1],&end,10)||*end)return 2;
  int pinned=(int)syscall(SYS_pidfd_open,(pid_t)pid,0);if(pinned<0)return 2;
  char proc[64];snprintf(proc,sizeof proc,"/proc/%ld",pid);
  int directory=open(proc,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(directory<0)return 2;
  const char *names[]={"user","mnt","net","ipc","uts"},*flags[]={"--user=","--mount=","--net=","--ipc=","--uts="};
  int descriptors[5];char options[5][64];
  for(unsigned i=0;i<5;i++){char path[32];snprintf(path,sizeof path,"ns/%s",names[i]);descriptors[i]=openat(directory,path,O_RDONLY);if(descriptors[i]<0)return 2;snprintf(options[i],sizeof options[i],"%s/proc/self/fd/%d",flags[i],descriptors[i]);}
  int root=openat(directory,"root",O_RDONLY|O_DIRECTORY);if(root<0)return 2;char root_option[64];snprintf(root_option,sizeof root_option,"--root=/proc/self/fd/%d",root);
  close(directory);
  struct pollfd alive={pinned,POLLIN,0};
  if(!process_info((pid_t)pid,&after,&parent)||after!=before||poll(&alive,1,0)!=0||interrupted)return 2;
  close(pinned);
  char *arguments[argc+12];unsigned count=0;arguments[count++]=argv[at+2];
  for(unsigned i=0;i<5;i++)arguments[count++]=options[i];
  arguments[count++]=root_option;arguments[count++]="--wdns=/";arguments[count++]="--preserve-credentials";arguments[count++]="--";
  for(int i=at+3;i<argc;i++)arguments[count++]=argv[i];
  arguments[count]=NULL;execv(arguments[0],arguments);return 127;
}
/* Resolve every ancestor without symlinks, then publish an owned staged tree
 * atomically without replacing an existing caller/attempt directory. */
static int publish_root(const char *source,const char *destination,const char *fence) {
  int lock=-1;
  if(fence){if(fence[0]!='/')return 2;lock=lifecycle_lock(fence,false);if(lock<0)return 2;if(interrupted){close(lock);return 2;}}
  char parent[4096];if(strlen(destination)>=sizeof parent||destination[0]!='/'){if(lock>=0)close(lock);return 2;}strcpy(parent,destination);
  char *name=strrchr(parent,'/');if(!name||name==parent){if(lock>=0)close(lock);return 2;}*name++=0;
  int slash=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(slash<0){if(lock>=0)close(lock);return 2;}
  struct open_how how={.flags=O_RDONLY|O_DIRECTORY|O_CLOEXEC,.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS};
  int dir=(int)syscall(SYS_openat2,slash,parent+1,&how,sizeof how);close(slash);if(dir<0){if(lock>=0)close(lock);return 2;}
  int result=(int)syscall(SYS_renameat2,AT_FDCWD,source,dir,name,RENAME_NOREPLACE);close(dir);
  if(lock>=0)close(lock);
  return result<0?2:0;
}
static int record_identity(const char *path) {
  char stat_path[64], stat_text[4096]; snprintf(stat_path, sizeof stat_path, "/proc/%ld/stat", (long)getpid());
  FILE *stat_file = fopen(stat_path, "r"); if (!stat_file || !fgets(stat_text, sizeof stat_text, stat_file)) return 2; fclose(stat_file);
  char *fields = strrchr(stat_text, ')'); if (!fields) return 2; fields += 2;
  char *save = NULL, *field = strtok_r(fields, " ", &save); unsigned index = 0;
  while (field && index < 19) { field = strtok_r(NULL, " ", &save); index++; }
  if (!field) return 2;
  char temporary[4096];
  int size = snprintf(temporary, sizeof temporary, "%s.next", path);
  if (size < 0 || (size_t)size >= sizeof temporary) return 2;
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600); if (fd < 0) return 2;
  if (dprintf(fd, "{\"pid\":%ld,\"start\":\"%s\"}", (long)getpid(), field) < 0 || fsync(fd) < 0) { close(fd); return 2; } close(fd);
  if (rename(temporary, path) < 0) return 2;
  return 0;
}
static int child_status(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 2;
}
static int reap_exact(pid_t child, int pidfd, uint32_t timeout_ms, int *status, bool stop_on_interrupt) {
  uint32_t deadline = clock_ms() + timeout_ms;
  for (;;) {
    pid_t result = waitpid(child, status, WNOHANG);
    if (result == child) return 0;
    if (result < 0 && errno != EINTR) return -1;
    if (stop_on_interrupt && interrupted) return 1;
    int32_t remain = (int32_t)(deadline - clock_ms());
    if (remain <= 0) return 1;
    if (pidfd >= 0) {
      struct pollfd waiter = { pidfd, POLLIN, 0 };
      if (poll(&waiter, 1, remain) < 0 && errno != EINTR) return -1;
    } else {
      struct timespec pause = { 0, 10000000 };
      nanosleep(&pause, NULL);
    }
  }
}
static int dispatch_owned(int argc, char **argv) {
  if (argc < 4 || argv[2][0] != '/' || argv[3][0] != '/') return 2;
  int lock = lifecycle_lock(argv[2], false);
  if (lock < 0) return 2;
  if (interrupted) { close(lock); return 2; }
  if (record_identity(argv[2])) { close(lock); return 2; }
  if (interrupted) { close(lock); return 2; }
  pid_t child = fork();
  if (child < 0) { close(lock); return 2; }
  if (child == 0) {
    close(lock);
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    execv(argv[3], &argv[3]);
    _exit(127);
  }
  int status = 0;
  int pidfd = (int)syscall(SYS_pidfd_open, child, 0);
  int waited = reap_exact(child, pidfd, 5000, &status, true);
  if (waited == 0 && !interrupted) {
    if (pidfd >= 0) close(pidfd);
    close(lock);
    return child_status(status);
  }
  if (waited != 0) {
    if (pidfd >= 0) (void)syscall(SYS_pidfd_send_signal, pidfd, SIGTERM, NULL, 0);
    else kill(child, SIGTERM);
    waited = reap_exact(child, pidfd, 1000, &status, false);
    if (waited != 0) {
      if (pidfd >= 0) (void)syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0);
      else kill(child, SIGKILL);
      waited = reap_exact(child, pidfd, 1000, &status, false);
    }
  }
  if (pidfd >= 0) close(pidfd);
  close(lock);
  if (waited == 0) {
    int code = child_status(status);
    return code == 0 ? 2 : code;
  }
  return 2;
}
static int open_beneath_parent(const char *path, char *name, size_t name_size) {
  if (!path || path[0] != '/' || strlen(path) >= 4096) return -1;
  char parent[4096];
  strcpy(parent, path);
  char *slash = strrchr(parent, '/');
  if (!slash || slash == parent || !slash[1]) return -1;
  if (strlen(slash + 1) >= name_size) return -1;
  strcpy(name, slash + 1);
  *slash = 0;
  int root = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (root < 0) return -1;
  struct open_how how = { .flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC, .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS };
  int dir = (int)syscall(SYS_openat2, root, parent + 1, &how, sizeof how);
  close(root);
  return dir;
}
static int claim_root(const char *source, const char *destination, const char *dev_text, const char *ino_text) {
  char *end = NULL;
  unsigned long long expected_dev = strtoull(dev_text, &end, 10);
  if (!dev_text[0] || *end) return 2;
  unsigned long long expected_ino = strtoull(ino_text, &end, 10);
  if (!ino_text[0] || *end) return 2;
  char src_name[256], dst_name[256];
  int src_parent = open_beneath_parent(source, src_name, sizeof src_name);
  if (src_parent < 0) return 2;
  int dst_parent = open_beneath_parent(destination, dst_name, sizeof dst_name);
  if (dst_parent < 0) { close(src_parent); return 2; }
  int src = openat(src_parent, src_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (src < 0) { close(src_parent); close(dst_parent); return 2; }
  struct stat info;
  if (fstat(src, &info) < 0 || (unsigned long long)info.st_dev != expected_dev || (unsigned long long)info.st_ino != expected_ino) {
    close(src); close(src_parent); close(dst_parent); return 2;
  }
  close(src);
  if ((int)syscall(SYS_renameat2, src_parent, src_name, dst_parent, dst_name, RENAME_NOREPLACE) < 0) {
    close(src_parent); close(dst_parent); return 2;
  }
  int dst = openat(dst_parent, dst_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (dst < 0 || fstat(dst, &info) < 0 || (unsigned long long)info.st_dev != expected_dev || (unsigned long long)info.st_ino != expected_ino) {
    if (dst >= 0) close(dst);
    (void)syscall(SYS_renameat2, dst_parent, dst_name, src_parent, src_name, RENAME_NOREPLACE);
    close(src_parent); close(dst_parent); return 2;
  }
  close(dst); close(src_parent); close(dst_parent); return 0;
}
static int supervise(int argc, char **argv) {
  if (argc < 4 || prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) return 2;
  int lock=lifecycle_lock(argv[2],false);if(lock<0)return 2;
  if(record_identity(argv[2])){close(lock);return 2;}
  if (interrupted) {close(lock);return 0;}
  pid_t child = fork(); if (child < 0) {close(lock);return 2;}
  if(child==0){close(lock);signal(SIGTERM,SIG_DFL);signal(SIGINT,SIG_DFL);if(setsid()<0)_exit(126);if(!strcmp(argv[1],"supervise-ns"))_exit(enter_namespaces(argc,argv,3));execv(argv[3],&argv[3]);_exit(127);}
  close(lock);
  unsigned long long own_start;pid_t own_parent;if(!process_info(getpid(),&own_start,&own_parent))return 2;
  /* Stay alive after an initial launcher exits while an adopted daemon lives. */
  while (!interrupted) {
    int status; pid_t result = waitpid(-1, &status, WNOHANG);
    if (result < 0 && errno == ECHILD) return 1;
    struct timespec pause = { 0, 10000000 }; nanosleep(&pause, NULL);
  }
  uint32_t deadline = clock_ms() + 10000;
  for (;;) {
    stop_descendants(getpid(),own_start,(int32_t)(clock_ms() - deadline) >= 0);
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    if (errno == ECHILD) return 0;
    struct timespec pause = { 0, 10000000 }; nanosleep(&pause, NULL);
  }
}

static int initialize_keymap(void) {
  xkb_context = xkb_context_new(XKB_CONTEXT_NO_ENVIRONMENT_NAMES);
  if (!xkb_context) return 2;
  const struct xkb_rule_names names = { .rules = "evdev", .model = "pc105", .layout = "us" };
  base_map = xkb_keymap_new_from_names(xkb_context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
  if (!base_map) return 2;
  char *compiled = xkb_keymap_get_as_string(base_map, XKB_KEYMAP_FORMAT_TEXT_V1);
  if (!compiled) return 2;
  base_size = (uint32_t)(strlen(compiled) + 1);
  base_fd = memfd_create("e2e-base-keymap", MFD_CLOEXEC);
  int result = base_fd < 0 || ftruncate(base_fd, base_size) < 0 || pwrite(base_fd, compiled, base_size, 0) != (ssize_t)base_size;
  free(compiled); if (result) return 2;
  const char *modifier_names[] = { XKB_MOD_NAME_SHIFT, XKB_MOD_NAME_CTRL, XKB_MOD_NAME_ALT, XKB_MOD_NAME_LOGO };
  for (unsigned i = 0; i < 4; i++) {
    xkb_mod_index_t index = xkb_keymap_mod_get_index(base_map, modifier_names[i]);
    if (index == XKB_MOD_INVALID || index >= 32) return 2;
    base_modifiers[i] = 1u << index;
  }
  memcpy(active_modifiers, base_modifiers, sizeof base_modifiers);
  for (xkb_keycode_t code = xkb_keymap_min_keycode(base_map); code <= xkb_keymap_max_keycode(base_map); code++) {
    for (xkb_level_index_t level = 0; level < 2 && level < xkb_keymap_num_levels_for_key(base_map, code, 0); level++) {
      const xkb_keysym_t *symbols;
      int count = xkb_keymap_key_get_syms_by_level(base_map, code, 0, level, &symbols);
      for (int i = 0; i < count; i++) {
        uint32_t scalar = xkb_keysym_to_utf32(symbols[i]);
        if (scalar && scalar < 128 && !ascii_keys[scalar].code) ascii_keys[scalar] = (struct key_entry){ code - 8, level ? 1u : 0u };
      }
    }
  }
  zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, base_fd, base_size);
  return wl_display_roundtrip(display) < 0 ? 2 : 0;
}
static void release_keys(void) {
  if (!keyboard) return;
  if (key_down) zwp_virtual_keyboard_v1_key(keyboard, clock_ms(), active_key, WL_KEYBOARD_KEY_STATE_RELEASED);
  key_down = false;
  for (unsigned i = 0; i < 4; i++) if (modifiers_down & (1u << i)) zwp_virtual_keyboard_v1_key(keyboard, clock_ms(), modifier_keys[i], WL_KEYBOARD_KEY_STATE_RELEASED);
  modifiers_down = 0;
  zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
}
static bool peer_live(FILE *connection) {
  struct pollfd peer={fileno(connection),POLLRDHUP|POLLHUP|POLLERR,0};
  return !interrupted&&poll(&peer,1,0)>=0&&!(peer.revents&(POLLRDHUP|POLLHUP|POLLERR|POLLNVAL));
}
static int wait_cutpoint(const char *name) {
  if (!socket_directory[0] || !name) return 0;
  char marker[4096], hold[4096], waiting[4096];
  int n = snprintf(marker, sizeof marker, "%s/cutpoint", socket_directory);
  if (n < 0 || (size_t)n >= sizeof marker) return 2;
  n = snprintf(hold, sizeof hold, "%s/cutpoint.hold", socket_directory);
  if (n < 0 || (size_t)n >= sizeof hold) return 2;
  n = snprintf(waiting, sizeof waiting, "%s/cutpoint.waiting", socket_directory);
  if (n < 0 || (size_t)n >= sizeof waiting) return 2;
  int fd = open(marker, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return 0;
  char buf[64];
  ssize_t got = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (got <= 0) return 0;
  while (got > 0 && (buf[got - 1] == '\n' || buf[got - 1] == '\r' || buf[got - 1] == ' ')) got--;
  buf[got] = 0;
  if (strcmp(buf, name)) return 0;
  int mark = open(waiting, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (mark >= 0) close(mark);
  while (!interrupted && faccessat(AT_FDCWD, hold, F_OK, AT_SYMLINK_NOFOLLOW) == 0) {
    struct timespec pause = { 0, 10000000 };
    nanosleep(&pause, NULL);
  }
  unlink(marker);
  unlink(waiting);
  return interrupted ? 2 : 0;
}
static int before_effect(FILE *connection, const char *name) {
  if (wait_cutpoint(name)) return 2;
  return peer_live(connection) ? 0 : 2;
}
static void note_effect(const char *name) {
  if (!socket_directory[0] || !name) return;
  char path[4096];
  int n = snprintf(path, sizeof path, "%s/effect.receipt", socket_directory);
  if (n < 0 || (size_t)n >= sizeof path) return;
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return;
  dprintf(fd, "%s\n", name);
  close(fd);
}
static int send_key(FILE *connection,const char *symbol,unsigned requested_modifiers) {
  if (requested_modifiers > 15) return 2;
  xkb_keysym_t keysym = xkb_keysym_from_name(symbol, XKB_KEYSYM_NO_FLAGS);
  if (keysym == XKB_KEY_NoSymbol) return 2;
  uint32_t scalar = xkb_keysym_to_utf32(keysym);
  /* Chord spelling Control+A means the A key, not an implicit Shift modifier. */
  if (requested_modifiers && scalar >= 'A' && scalar <= 'Z') { scalar += 'a' - 'A'; keysym = xkb_utf32_to_keysym(scalar); }
  struct key_entry entry = { 0, 0 };
  if (scalar && scalar < 128) entry = ascii_keys[scalar];
  if (!entry.code && scalar <= 127) {
    for (xkb_keycode_t code = xkb_keymap_min_keycode(base_map); code <= xkb_keymap_max_keycode(base_map) && !entry.code; code++) {
      const xkb_keysym_t *symbols;
      int count = xkb_keymap_key_get_syms_by_level(base_map, code, 0, 0, &symbols);
      for (int i = 0; i < count; i++) if (symbols[i] == keysym) entry.code = code - 8;
    }
  }
  if (entry.code) {
    if (unicode_active) {
      if (before_effect(connection, "keymap-restore")) return 2;
      zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, base_fd, base_size);
      unicode_active = false;
      memcpy(active_modifiers, base_modifiers, sizeof base_modifiers);
      if (wl_display_roundtrip(display) < 0) return 2;
      note_effect("keymap-restore");
      if (!peer_live(connection)) return 2;
    }
  } else if (scalar > 127) {
    if (!unicode_active || unicode_scalar != scalar) {
      char keymap_text[2048];
      int length = snprintf(keymap_text, sizeof keymap_text,
        "xkb_keymap { xkb_keycodes \"e2e\" { minimum=8; maximum=255; <KEY>=38; <CTRL>=37; <SHIFT>=50; <ALT>=64; <META>=133; }; "
        "xkb_types \"e2e\" { include \"complete\" }; xkb_compatibility \"e2e\" { include \"complete\" }; "
        "xkb_symbols \"e2e\" { key <KEY> { type=\"ONE_LEVEL\", symbols[Group1]=[U%04X] }; "
        "key <CTRL> { [Control_L] }; modifier_map Control { <CTRL> }; key <SHIFT> { [Shift_L] }; modifier_map Shift { <SHIFT> }; "
        "key <ALT> { [Alt_L] }; modifier_map Mod1 { <ALT> }; key <META> { [Super_L] }; modifier_map Mod4 { <META> }; }; };", scalar);
      if (length < 0 || (size_t)length >= sizeof keymap_text) return 2;
      struct xkb_keymap *map = xkb_keymap_new_from_string(xkb_context, keymap_text, XKB_KEYMAP_FORMAT_TEXT_V1, XKB_KEYMAP_COMPILE_NO_FLAGS);
      if (!map) return 2;
      const char *names[] = { XKB_MOD_NAME_SHIFT, XKB_MOD_NAME_CTRL, XKB_MOD_NAME_ALT, XKB_MOD_NAME_LOGO };
      uint32_t next_modifiers[4];
      for (unsigned i = 0; i < 4; i++) {
        xkb_mod_index_t index = xkb_keymap_mod_get_index(map, names[i]);
        if (index == XKB_MOD_INVALID || index >= 32) { xkb_keymap_unref(map); return 2; }
        next_modifiers[i] = 1u << index;
      }
      xkb_keymap_unref(map);
      if (unicode_fd < 0) unicode_fd = memfd_create("e2e-unicode-keymap", MFD_CLOEXEC);
      uint32_t size = (uint32_t)length + 1;
      if (unicode_fd < 0 || ftruncate(unicode_fd, size) < 0 || pwrite(unicode_fd, keymap_text, size, 0) != (ssize_t)size) return 2;
      if (before_effect(connection, "keymap-unicode")) return 2;
      zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, unicode_fd, size);
      unicode_active = true; unicode_scalar = scalar;
      memcpy(active_modifiers, next_modifiers, sizeof next_modifiers);
      if (wl_display_roundtrip(display) < 0) return 2;
      note_effect("keymap-unicode");
      if (!peer_live(connection)) return 2;
    }
    entry.code = 30;
  } else return 2;
  requested_modifiers |= entry.modifiers;
  uint32_t depressed = 0;
  for (unsigned i = 0; i < 4; i++) if (requested_modifiers & (1u << i)) {
    char cut[32];
    int n = snprintf(cut, sizeof cut, "modifier-press-%u", i);
    if (n < 0 || (size_t)n >= sizeof cut) return 2;
    if ((i == 0 && before_effect(connection, "modifier-press")) || before_effect(connection, cut)) return 2;
    zwp_virtual_keyboard_v1_key(keyboard, clock_ms(), modifier_keys[i], WL_KEYBOARD_KEY_STATE_PRESSED);
    modifiers_down |= 1u << i; depressed |= active_modifiers[i];
    if (wl_display_roundtrip(display) < 0) return 2;
    note_effect("modifier-press");
    note_effect(cut);
  }
  if (before_effect(connection, "modifier-state")) return 2;
  zwp_virtual_keyboard_v1_modifiers(keyboard, depressed, 0, 0, 0);
  if (wl_display_roundtrip(display) < 0) return 2;
  note_effect("modifier-state");
  if (before_effect(connection, "key-press")) return 2;
  active_key = entry.code;
  zwp_virtual_keyboard_v1_key(keyboard, clock_ms(), active_key, WL_KEYBOARD_KEY_STATE_PRESSED); key_down = true;
  if (wl_display_roundtrip(display) < 0) return 2;
  note_effect("key-press");
  release_keys();
  return wl_display_roundtrip(display) < 0 ? 2 : 0;
}
static int text(FILE *connection, size_t remaining) {
  while (remaining && !interrupted) {
    if(!peer_live(connection))return 2;
    int first = fgetc(connection); remaining--;
    if (first <= 0) return 2;
    uint32_t scalar, minimum; unsigned extra;
    if (first < 0x80) { scalar = (uint32_t)first; extra = 0; minimum = 0; }
    else if ((first & 0xe0) == 0xc0) { scalar = first & 0x1f; extra = 1; minimum = 0x80; }
    else if ((first & 0xf0) == 0xe0) { scalar = first & 0x0f; extra = 2; minimum = 0x800; }
    else if ((first & 0xf8) == 0xf0) { scalar = first & 7; extra = 3; minimum = 0x10000; }
    else return 2;
    if (remaining < extra) return 2;
    for (unsigned i = 0; i < extra; i++) {
      int continuation = fgetc(connection); remaining--;
      if (continuation < 0 || (continuation & 0xc0) != 0x80) return 2;
      scalar = (scalar << 6) | (continuation & 0x3f);
    }
    if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) return 2;
    char symbol[24]; snprintf(symbol, sizeof symbol, "U%04X", scalar);
    const char *key = scalar == '\n' ? "Return" : scalar == '\t' ? "Tab" : symbol;
    if(!peer_live(connection)||send_key(connection,key,0))return 2;
  }
  return interrupted ? 2 : 0;
}
static int request(FILE *connection) {
  char header[128], symbol[32]; unsigned mask, x, y, width, height, click;
  int result=2;
  if(!fgets(header,sizeof header,connection)||!peer_live(connection))goto release;
  if(sscanf(header,"K %u %31s",&mask,symbol)==2)result=send_key(connection,symbol,mask);
  else if (sscanf(header, "P %u %u %u %u %u", &x, &y, &width, &height, &click) == 5 && width && height && x < width && y < height && click <= 1) {
    if (before_effect(connection, "pointer-motion")) goto release;
    zwlr_virtual_pointer_v1_motion_absolute(pointer, clock_ms(), x, y, width, height); zwlr_virtual_pointer_v1_frame(pointer);
    if (wl_display_roundtrip(display) < 0) goto release;
    note_effect("pointer-motion");
    if (click) {
      if (before_effect(connection, "pointer-button")) goto release;
      zwlr_virtual_pointer_v1_button(pointer, clock_ms(), 0x110, WL_POINTER_BUTTON_STATE_PRESSED); pointer_down = true; zwlr_virtual_pointer_v1_frame(pointer);
      if (wl_display_roundtrip(display) < 0) goto release;
      note_effect("pointer-button");
      zwlr_virtual_pointer_v1_button(pointer, clock_ms(), 0x110, WL_POINTER_BUTTON_STATE_RELEASED); pointer_down = false; zwlr_virtual_pointer_v1_frame(pointer);
    }
    result = wl_display_roundtrip(display) < 0 ? 2 : 0;
  } else {
    size_t size;
    if (sscanf(header, "T %zu", &size) == 1 && size <= 4 * 1024 * 1024) result = text(connection, size);
  }
release:
  release_keys();
  if (pointer_down) { zwlr_virtual_pointer_v1_button(pointer, clock_ms(), 0x110, WL_POINTER_BUTTON_STATE_RELEASED); pointer_down = false; zwlr_virtual_pointer_v1_frame(pointer); }
  if (wl_display_roundtrip(display) < 0) result = 2;
  dprintf(fileno(connection), "%s", result ? "ERROR\n" : "OK\n");
  return wl_display_get_error(display) ? 2 : 0;
}
static int stop_owned(const char *pid_text, const char *expected_start) {
  char *end; long pid = strtol(pid_text, &end, 10);
  if (*end || pid <= 0 || pid > 0x7fffffff) return 2;
  int pidfd = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
  if (pidfd < 0) return errno == ESRCH ? 0 : 2;
  char path[64], value[4096]; snprintf(path, sizeof path, "/proc/%ld/stat", pid);
  FILE *file = fopen(path, "r");
  if (!file) { close(pidfd); return errno == ENOENT ? 0 : 2; }
  if (!fgets(value, sizeof value, file)) { fclose(file); close(pidfd); return 2; }
  fclose(file);
  char *fields = strrchr(value, ')'); if (!fields) { close(pidfd); return 2; } fields += 2;
  char *save = NULL, *field = strtok_r(fields, " ", &save);
  for (unsigned i = 0; field && i < 19; i++) field = strtok_r(NULL, " ", &save);
  if (!field || strcmp(field, expected_start)) { close(pidfd); return 2; }
  int result = (int)syscall(SYS_pidfd_send_signal, pidfd, SIGTERM, NULL, 0);
  close(pidfd); return result < 0 && errno != ESRCH ? 2 : 0;
}
int main(int argc, char **argv) {
  struct sigaction action = { .sa_handler = interrupt }; sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); signal(SIGPIPE, SIG_IGN);
  if (argc >= 4 && strcmp(argv[1], "exec-owned") == 0) {
    int lock=lifecycle_lock(argv[2],false);if(lock<0)return 2;
    if(record_identity(argv[2])){close(lock);return 2;}
    if(interrupted){close(lock);return 0;}
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    execv(argv[3], &argv[3]); return 127;
  }
  if(argc>1&&(!strcmp(argv[1],"supervise")||!strcmp(argv[1],"supervise-ns")))return supervise(argc,argv);
  if(argc>1&&!strcmp(argv[1],"enter-ns"))return enter_namespaces(argc,argv,2);
  if(argc==4&&!strcmp(argv[1],"publish-root"))return publish_root(argv[2],argv[3],NULL);
  if(argc==5&&!strcmp(argv[1],"publish-root"))return publish_root(argv[2],argv[3],argv[4]);
  if(argc==3&&strcmp(argv[1],"close")==0){int lock=lifecycle_lock(argv[2],true);if(lock<0)return 2;close(lock);return 0;}
  if (argc == 4 && strcmp(argv[1], "stop") == 0) return stop_owned(argv[2], argv[3]);
  if (argc >= 4 && !strcmp(argv[1], "dispatch-owned")) return dispatch_owned(argc, argv);
  if (argc == 6 && !strcmp(argv[1], "claim-root")) return claim_root(argv[2], argv[3], argv[4], argv[5]);
  if (argc != 4 || strcmp(argv[1], "serve") != 0 || !getenv("XDG_RUNTIME_DIR") || !getenv("WAYLAND_DISPLAY")) return 2;
  wanted_seat = argv[2]; display = wl_display_connect(NULL); if (!display) return 2;
  struct wl_registry *registry = wl_display_get_registry(display); wl_registry_add_listener(registry, &registry_listener, NULL);
  int result = 2, listener = -1;
  if (wl_display_roundtrip(display) < 0 || wl_display_roundtrip(display) < 0 || matches != 1 || !keyboard_manager || !pointer_manager) goto cleanup;
  keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(keyboard_manager, seat);
  pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointer_manager, seat);
  if (!keyboard || !pointer) goto cleanup;
  if (initialize_keymap() || wl_display_roundtrip(display) < 0 || (named_capabilities & (WL_SEAT_CAPABILITY_KEYBOARD | WL_SEAT_CAPABILITY_POINTER)) != (WL_SEAT_CAPABILITY_KEYBOARD | WL_SEAT_CAPABILITY_POINTER)) goto cleanup;
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (strlen(argv[3]) >= sizeof address.sun_path) goto cleanup;
  strcpy(address.sun_path, argv[3]);
  if (strlen(argv[3]) >= sizeof socket_directory) goto cleanup;
  strcpy(socket_directory, argv[3]);
  char *dir_slash = strrchr(socket_directory, '/');
  if (!dir_slash || dir_slash == socket_directory) goto cleanup;
  *dir_slash = 0;
  listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof address) < 0 || chmod(argv[3], 0600) < 0 || listen(listener, 4) < 0) goto cleanup;
  result = 0;
  while (!interrupted) {
    if (wl_display_dispatch_pending(display) < 0 || wl_display_flush(display) < 0) { result = 2; break; }
    struct pollfd descriptors[] = { { listener, POLLIN, 0 }, { wl_display_get_fd(display), POLLIN, 0 } };
    int ready = poll(descriptors, 2, -1);
    if (ready < 0) { if (errno == EINTR) continue; result = 2; break; }
    if (descriptors[1].revents && wl_display_dispatch(display) < 0) { result = 2; break; }
    if (descriptors[0].revents & POLLIN) {
      int fd = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
      if (fd < 0) { if (errno == EINTR) continue; result = 2; break; }
      struct ucred credentials; socklen_t length = sizeof credentials;
      if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) < 0 || credentials.uid != getuid()) { close(fd); result = 2; break; }
      FILE *connection = fdopen(fd, "r");
      if (!connection) { close(fd); result = 2; break; }
      int failed = request(connection); fclose(connection);
      if (failed) { result = 2; break; }
    }
  }
cleanup:
  if (listener >= 0) { close(listener); unlink(argv[3]); }
  release_keys();
  if (keyboard) zwp_virtual_keyboard_v1_destroy(keyboard);
  if (pointer) {
    if (pointer_down) { zwlr_virtual_pointer_v1_button(pointer, clock_ms(), 0x110, WL_POINTER_BUTTON_STATE_RELEASED); zwlr_virtual_pointer_v1_frame(pointer); }
    zwlr_virtual_pointer_v1_destroy(pointer);
  }
  if (wl_display_roundtrip(display) < 0) result = 2;
  wl_display_disconnect(display);
  if (base_fd >= 0) close(base_fd);
  if (unicode_fd >= 0) close(unicode_fd);
  if (base_map) xkb_keymap_unref(base_map);
  if (xkb_context) xkb_context_unref(xkb_context);
  return result;
}
