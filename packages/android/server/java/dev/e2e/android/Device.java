package dev.e2e.android;

import android.app.UiAutomation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The device as the engine contract sees it: one observation tree read off
 * every app window's accessibility nodes, and input injected as touch and
 * key events, all in process. Coordinates are physical pixels, the space
 * the platform reports bounds in, with the viewport the display's size.
 */
final class Device {
  private static final String ROOT_ID = "root";
  private static final String SYSTEM_UI = "com.android.systemui";
  private static final int MAX_NODES = 5000;
  private static final int MAX_DEPTH = 128;
  private static final int NAME_LIMIT = 256;
  private static final int TEXT_LIMIT = 512;

  private static final Map<String, String> ROLES = new HashMap<>();
  private static final Map<String, String> ROLE_DESCRIPTIONS = new HashMap<>();
  private static final Set<String> TEXT_INPUT_ROLES = new HashSet<>();

  static {
    String[][] roles = {
      {"text-view", "text"}, {"edit-text", "textbox"}, {"auto-complete-text-view", "textbox"},
      {"text-input-edit-text", "textbox"}, {"search-view", "textbox"}, {"button", "button"},
      {"image-button", "button"}, {"material-button", "button"}, {"image-view", "image"},
      {"switch", "switch"}, {"switch-compat", "switch"}, {"switch-material", "switch"},
      {"toggle-button", "switch"}, {"check-box", "checkbox"}, {"material-check-box", "checkbox"},
      {"radio-button", "radio"}, {"seek-bar", "slider"}, {"slider", "slider"}, {"spinner", "combobox"},
      {"progress-bar", "progressbar"}, {"radio-group", "radiogroup"}, {"number-picker", "spinbutton"},
      {"toolbar", "toolbar"}, {"tab-layout", "tablist"}, {"tab-widget", "tablist"},
      {"bottom-navigation-view", "tablist"}, {"tab-layout$tab-view", "tab"},
      {"bottom-navigation-item-view", "tab"}, {"web-view", "document"}, {"recycler-view", "list"},
      {"list-view", "list"}, {"abs-list-view", "list"}, {"grid-view", "list"}, {"scroll-view", "group"},
      {"horizontal-scroll-view", "group"}, {"view-group", "group"}, {"view", "group"},
      {"compose-view", "group"}, {"view-factory-holder", "group"}, {"card-view", "group"},
    };
    for (String[] role : roles) ROLES.put(role[0], role[1]);
    String[][] descriptions = {
      {"alert", "alert"}, {"checkbox", "checkbox"}, {"combo box", "combobox"}, {"menu", "menu"},
      {"menu bar", "menubar"}, {"menu item", "menuitem"}, {"progress bar", "progressbar"},
      {"radio button", "radio"}, {"radio group", "radiogroup"}, {"scroll bar", "scrollbar"},
      {"spin button", "spinbutton"}, {"switch", "switch"}, {"tab", "tab"}, {"tab list", "tablist"},
      {"timer", "timer"}, {"tool bar", "toolbar"}, {"link", "link"}, {"button", "button"},
      {"image", "image"}, {"header", "heading"}, {"heading", "heading"},
    };
    for (String[] description : descriptions) ROLE_DESCRIPTIONS.put(description[0], description[1]);
    Collections.addAll(TEXT_INPUT_ROLES, "textbox", "combobox", "searchbox");
  }

  private final Context context;
  private final UiAutomation automation;
  private Map<String, AccessibilityNodeInfo> nodes = new HashMap<>();
  private Map<String, Rect> observedBounds = new HashMap<>();
  private String packageName;
  private String launchComponent;
  private int counter;
  private int generation;

  Device(Context context, UiAutomation automation) {
    this.context = context;
    this.automation = automation;
  }

  /** Throws `CANCELLED` once the operation's signal aborted, so an abandoned call frees the device. */
  void checkCancelled(Operation operation) throws EngineException {
    if (operation.cancelled()) throw EngineException.cancelled();
  }

  /** Sleeps in short steps, stopping with `CANCELLED` as soon as the operation is abandoned. */
  private void pause(long ms, Operation operation) throws EngineException {
    long until = SystemClock.uptimeMillis() + ms;
    for (long left = ms; left > 0; left = until - SystemClock.uptimeMillis()) {
      checkCancelled(operation);
      SystemClock.sleep(Math.min(left, 25));
    }
    checkCancelled(operation);
  }

  /** Pins the target's app and brings it to the front; an app already running keeps its state. */
  void init(JSONObject app, Operation operation) throws Exception {
    packageName = app == null ? null : app.optString("bundleId", null);
    // The name reaches shell commands, so it must be a package name and nothing else.
    if (packageName != null && !packageName.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")) {
      throw EngineException.invalidState("app.bundleId " + packageName + " is not an Android package name");
    }
    launchComponent = null;
    if (packageName != null) launch(false, operation);
  }

  void startAttempt() {
    nodes = new HashMap<>();
  }

  JSONObject environment() throws JSONException {
    JSONObject facts = new JSONObject();
    facts.put("platform", "android");
    facts.put("device", Build.MODEL);
    facts.put("os", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
    facts.put("engine", "android direct (UiAutomation)");
    return facts;
  }

  // ---- observation ----

  JSONObject observe(boolean pixels) throws Exception {
    Point size = displaySize();
    Map<String, AccessibilityNodeInfo> fresh = new HashMap<>();
    Map<String, Rect> freshBounds = new HashMap<>();
    counter = 0;
    generation += 1;
    boolean[] truncated = {false};
    boolean keyboard = false;
    String location = null;
    List<AccessibilityWindowInfo> windows = new ArrayList<>(automation.getWindows());
    Collections.sort(windows, (a, b) -> Integer.compare(a.getLayer(), b.getLayer()));
    JSONArray children = new JSONArray();
    for (AccessibilityWindowInfo window : windows) {
      if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
        keyboard = true;
        continue;
      }
      if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION && window.getType() != AccessibilityWindowInfo.TYPE_SYSTEM) continue;
      AccessibilityNodeInfo root = window.getRoot();
      if (root == null) continue;
      CharSequence rootPackage = root.getPackageName();
      if (rootPackage != null && SYSTEM_UI.contentEquals(rootPackage)) continue;
      if (window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && rootPackage != null) location = rootPackage.toString();
      JSONObject converted = convert(root, 0, fresh, freshBounds, truncated);
      if (converted != null) children.put(converted);
    }
    nodes = fresh;
    observedBounds = freshBounds;
    JSONObject rootNode = new JSONObject();
    rootNode.put("ref", ref(ROOT_ID));
    rootNode.put("role", "screen");
    rootNode.put("rect", rect(0, 0, size.x, size.y));
    rootNode.put("children", children);
    JSONObject snapshot = new JSONObject();
    if (location != null) snapshot.put("location", location);
    snapshot.put("root", rootNode);
    JSONObject viewport = new JSONObject();
    viewport.put("width", size.x);
    viewport.put("height", size.y);
    snapshot.put("viewport", viewport);
    if (truncated[0]) snapshot.put("truncated", true);
    snapshot.put("keyboardVisible", keyboard);
    if (pixels) {
      // Masked from a scan of every window, not from the tree: a field the
      // tree leaves out (past the node cap, in a window it skips) is never
      // shown unmasked.
      List<Rect> before = secureFields();
      Bitmap capture = automation.takeScreenshot();
      // A field that appeared or moved during the capture is masked too.
      List<Rect> secure = union(before, secureFields());
      Bitmap bitmap = masked(capture, secure);
      if (bitmap != null) {
        snapshot.put("maskedRegionCount", secure.size());
        JSONObject image = new JSONObject();
        image.put("data", encodePng(bitmap));
        image.put("mediaType", "image/png");
        image.put("width", bitmap.getWidth());
        image.put("height", bitmap.getHeight());
        image.put("scale", (double) bitmap.getWidth() / size.x);
        snapshot.put("pixels", image);
        bitmap.recycle();
      }
    }
    return snapshot;
  }

  private JSONObject convert(AccessibilityNodeInfo node, int depth, Map<String, AccessibilityNodeInfo> fresh, Map<String, Rect> freshBounds, boolean[] truncated) throws JSONException {
    if (fresh.size() >= MAX_NODES || depth > MAX_DEPTH) {
      truncated[0] = true;
      return null;
    }
    counter += 1;
    // The generation keeps a ref from an older observation from naming
    // whichever node now holds its position: it is stale instead.
    String id = generation + "." + counter;
    fresh.put(id, node);
    JSONObject out = new JSONObject();
    out.put("ref", ref(id));
    boolean editable = node.isEditable();
    String role = role(node, editable);
    if (role != null) out.put("role", role);
    String description = nonEmpty(node.getContentDescription());
    String text = nonEmpty(node.getText());
    String hint = Build.VERSION.SDK_INT >= 26 ? nonEmpty(node.getHintText()) : null;
    boolean showingHint = Build.VERSION.SDK_INT >= 26 && node.isShowingHintText();
    if (showingHint) text = null;
    if (editable) {
      String name = description != null ? description : hint;
      if (name != null) out.put("name", cut(name, NAME_LIMIT));
      if (text != null && !node.isPassword()) out.put("value", text);
    } else {
      // A secure node's text never leaves the device, editable or not.
      if (node.isPassword()) text = null;
      String name = description != null ? description : text;
      if (name != null) out.put("name", cut(name, NAME_LIMIT));
      if (text != null) out.put("text", cut(text, TEXT_LIMIT));
    }
    String resource = node.getViewIdResourceName();
    if (resource != null && !resource.isEmpty()) out.put("testId", resource);
    if (node.isPassword()) out.put("inputPurpose", "password");
    JSONObject states = new JSONObject();
    if (!node.isEnabled()) states.put("disabled", true);
    if (node.isCheckable() && node.isChecked()) states.put("checked", true);
    if (node.isSelected()) states.put("selected", true);
    if (node.isFocused()) states.put("focused", true);
    if (node.isPassword()) states.put("secure", true);
    if (!node.isVisibleToUser()) states.put("hidden", true);
    if (states.length() > 0) out.put("states", states);
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    out.put("rect", rect(bounds.left, bounds.top, bounds.width(), bounds.height()));
    freshBounds.put(id, new Rect(bounds));
    JSONObject attributes = new JSONObject();
    CharSequence className = node.getClassName();
    if (className != null) attributes.put("class", className.toString());
    if (hint != null) attributes.put("placeholder", hint);
    if (attributes.length() > 0) out.put("attributes", attributes);
    int count = node.getChildCount();
    if (count > 0) {
      JSONArray children = new JSONArray();
      for (int index = 0; index < count; index++) {
        AccessibilityNodeInfo child = node.getChild(index);
        if (child == null) continue;
        JSONObject converted = convert(child, depth + 1, fresh, freshBounds, truncated);
        if (converted != null) children.put(converted);
      }
      if (children.length() > 0) out.put("children", children);
    }
    return out;
  }

  private static String role(AccessibilityNodeInfo node, boolean editable) {
    String role = null;
    if (Build.VERSION.SDK_INT >= 28 && node.isHeading()) role = "heading";
    if (role == null) {
      Bundle extras = node.getExtras();
      CharSequence description = extras == null ? null : extras.getCharSequence("AccessibilityNodeInfo.roleDescription");
      if (description != null) role = ROLE_DESCRIPTIONS.get(description.toString().split(",")[0].trim().toLowerCase(Locale.ROOT));
    }
    if (role == null) {
      CharSequence className = node.getClassName();
      if (className != null) {
        String kind = kebab(className.toString());
        role = ROLES.containsKey(kind) ? ROLES.get(kind) : (kind.endsWith("layout") ? "group" : kind);
      }
    }
    if (editable && (role == null || !TEXT_INPUT_ROLES.contains(role))) role = "textbox";
    return role;
  }

  /** `android.widget.EditText` as `edit-text`, the kind the mobile engine names Android classes by. */
  private static String kebab(String className) {
    String simple = className.substring(className.lastIndexOf('.') + 1);
    StringBuilder out = new StringBuilder();
    for (int index = 0; index < simple.length(); index++) {
      char character = simple.charAt(index);
      if (Character.isUpperCase(character)) {
        if (index > 0 && simple.charAt(index - 1) != '$') out.append('-');
        out.append(Character.toLowerCase(character));
      } else {
        out.append(character);
      }
    }
    return out.toString();
  }

  // ---- actions ----

  void perform(String id, JSONObject action, Operation operation) throws Exception {
    checkCancelled(operation);
    String kind = action.getString("kind");
    if (ROOT_ID.equals(id)) {
      if (!"swipe".equals(kind)) throw EngineException.unsupported("the screen root only takes a swipe");
      Point size = displaySize();
      swipe(new Rect(0, 0, size.x, size.y), action.getString("direction"), action.optString("momentum", "slow"), operation);
      settle(operation);
      return;
    }
    AccessibilityNodeInfo node = live(id);
    Rect bounds = settledBounds(node, id, operation);
    switch (kind) {
      case "tap":
        tap(actionable(bounds, id));
        break;
      case "doubleTap": {
        float[] point = actionable(bounds, id);
        tap(point);
        pause(80, operation);
        tap(point);
        break;
      }
      case "longPress":
        longPress(actionable(bounds, id), action.optLong("durationMs", ViewConfiguration.getLongPressTimeout() + 200), operation);
        break;
      case "focus":
        if (!node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) tap(actionable(bounds, id));
        break;
      case "check":
      case "uncheck": {
        boolean wanted = "check".equals(kind);
        if (!node.isCheckable()) throw EngineException.unsupported("node " + id + " has no checked state");
        if (node.isChecked() != wanted) tap(actionable(bounds, id));
        break;
      }
      case "fill":
      case "clear": {
        if (!node.isEditable()) throw EngineException.notActionable("node " + id + " does not take text");
        if (!node.isFocused()) tap(actionable(bounds, id));
        setText(node, "fill".equals(kind) ? action.getString("value") : "");
        break;
      }
      case "press":
        // A field is tapped to take keys, as a person would; anything else
        // is focused without a tap, so a key pressed on a button does not
        // also activate it.
        if (!node.isFocused()) {
          if (node.isEditable()) tap(actionable(bounds, id));
          else node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        }
        press(action.getString("key"), operation);
        break;
      case "swipe":
        swipe(bounds, action.getString("direction"), action.optString("momentum", "slow"), operation);
        break;
      case "dragTo": {
        AccessibilityNodeInfo target = live(action.getJSONObject("target").getString("id"));
        Rect targetBounds = new Rect();
        target.getBoundsInScreen(targetBounds);
        drag(actionable(bounds, id), new float[] {targetBounds.exactCenterX(), targetBounds.exactCenterY()}, operation);
        break;
      }
      default:
        throw EngineException.unsupported("the \"" + kind + "\" action is not supported");
    }
    settle(operation);
  }

  void performAt(float x, float y, JSONObject action, Operation operation) throws Exception {
    checkCancelled(operation);
    String kind = action.getString("kind");
    float[] point = {x, y};
    switch (kind) {
      case "tap":
        tap(point);
        break;
      case "doubleTap":
        tap(point);
        pause(80, operation);
        tap(point);
        break;
      case "longPress":
        longPress(point, action.optLong("durationMs", ViewConfiguration.getLongPressTimeout() + 200), operation);
        break;
      case "dragTo": {
        JSONObject target = action.getJSONObject("target");
        drag(point, new float[] {(float) target.getDouble("x"), (float) target.getDouble("y")}, operation);
        break;
      }
      case "swipe": {
        Point size = displaySize();
        int half = Math.min(size.x, size.y) / 4;
        swipe(new Rect((int) x - half, (int) y - half, (int) x + half, (int) y + half), action.getString("direction"), action.optString("momentum", "slow"), operation);
        break;
      }
      case "swipeTo": {
        JSONObject target = action.getJSONObject("target");
        gestureToRest(point, new float[] {(float) target.getDouble("x"), (float) target.getDouble("y")}, action.optLong("durationMs", 300), 0, false, operation);
        break;
      }
      default:
        throw EngineException.unsupported("the \"" + kind + "\" action at a point is not supported");
    }
    settle(operation);
  }

  void type(String text, boolean replace, Operation operation) throws Exception {
    checkCancelled(operation);
    AccessibilityNodeInfo focused = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    if (focused == null || !focused.isEditable()) throw EngineException.notActionable("nothing that takes text has focus");
    if (replace) setText(focused, "");
    KeyCharacterMap map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
    KeyEvent[] events = map.getEvents(text.toCharArray());
    if (events != null) {
      // The dispatcher keeps injection order, so only the last key waits for
      // delivery: the text has reached the app once this returns.
      for (int index = 0; index < events.length; index++) {
        KeyEvent event = KeyEvent.changeTimeRepeat(events[index], SystemClock.uptimeMillis(), 0);
        if (!automation.injectInputEvent(event, index == events.length - 1)) throw EngineException.failure("the key was not delivered");
      }
      return;
    }
    // A character the virtual keyboard map cannot spell (an emoji, a
    // non-Latin script) goes through the field itself, appended at the end.
    for (int offset = 0; offset < text.length(); ) {
      int codePoint = text.codePointAt(offset);
      String character = new String(Character.toChars(codePoint));
      KeyEvent[] spelled = map.getEvents(character.toCharArray());
      if (spelled != null) {
        for (KeyEvent event : spelled) inject(KeyEvent.changeTimeRepeat(event, SystemClock.uptimeMillis(), 0));
      } else {
        AccessibilityNodeInfo field = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field == null) throw EngineException.notActionable("the focused field lost focus while typing");
        field.refresh();
        CharSequence current = field.isShowingHintText() ? "" : field.getText();
        setText(field, (current == null ? "" : current.toString()) + character);
      }
      offset += Character.charCount(codePoint);
    }
  }

  /**
   * Presses one key of the contract grammar the way the soft keyboard can:
   * Enter, Space, or one character. A device's keyboard holds no modifier
   * and has no Escape or arrow keys, so those are refused, as the mobile
   * engine refuses them, instead of being injected as hardware keys a person
   * could not press.
   */
  void press(String key, Operation operation) throws Exception {
    checkCancelled(operation);
    int separator = key.length() > 1 ? key.lastIndexOf('+', key.length() - 2) : -1;
    if (separator > 0) {
      throw EngineException.unsupported("the soft keyboard cannot hold " + key.substring(0, separator) + " on a device surface; press the key alone");
    }
    if (key.equals("Enter")) {
      pressCode(KeyEvent.KEYCODE_ENTER);
      return;
    }
    String text = key.equals("Space") ? " " : key;
    KeyEvent[] events = text.codePointCount(0, text.length()) == 1
        ? KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray())
        : null;
    if (events == null) {
      throw EngineException.unsupported("the soft keyboard cannot press " + key + " on a device surface; only Enter, Space, and single characters reach the soft keyboard");
    }
    for (KeyEvent event : events) inject(KeyEvent.changeTimeRepeat(event, SystemClock.uptimeMillis(), 0));
  }

  void dismissKeyboard() throws Exception {
    for (AccessibilityWindowInfo window : automation.getWindows()) {
      if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
        pressCode(KeyEvent.KEYCODE_BACK);
        return;
      }
    }
  }

  void back(Operation operation) throws Exception {
    checkCancelled(operation);
    pressCode(KeyEvent.KEYCODE_BACK);
  }

  /** Relaunches the pinned app; with `clear`, its persisted state is wiped first. */
  void restart(boolean clear, Operation operation) throws Exception {
    checkCancelled(operation);
    if (packageName == null) throw EngineException.unsupported("launching the app needs the target's app.bundleId");
    shell((clear ? "pm clear " : "am force-stop ") + packageName);
    launch(true, operation);
  }

  /** A screenshot with every secure field painted over, found by a scan that leaves the observation's refs alone. */
  String screenshotBase64(Operation operation) throws Exception {
    checkCancelled(operation);
    List<Rect> before = secureFields();
    Bitmap capture = automation.takeScreenshot();
    Bitmap bitmap = masked(capture, union(before, secureFields()));
    if (bitmap == null) throw EngineException.failure("the screen could not be captured");
    try {
      return encodePng(bitmap);
    } finally {
      bitmap.recycle();
    }
  }

  // ---- helpers ----

  private void launch(boolean waitForWindow, Operation operation) throws Exception {
    if (launchComponent == null) {
      String resolved = shell("cmd package resolve-activity --brief -c android.intent.category.LAUNCHER " + packageName).trim();
      String[] lines = resolved.split("\n");
      String component = lines[lines.length - 1].trim();
      if (!component.contains("/")) throw EngineException.invalidState("app " + packageName + " is not installed or has no launcher activity");
      launchComponent = component;
    }
    shell("am start -W -n " + launchComponent);
    if (!waitForWindow) return;
    long deadline = SystemClock.uptimeMillis() + 10_000;
    while (SystemClock.uptimeMillis() < deadline) {
      AccessibilityNodeInfo root = automation.getRootInActiveWindow();
      if (root != null && root.getPackageName() != null && packageName.contentEquals(root.getPackageName())) return;
      pause(50, operation);
    }
  }

  private AccessibilityNodeInfo live(String id) throws EngineException {
    AccessibilityNodeInfo node = nodes.get(id);
    if (node == null || !node.refresh()) throw EngineException.stale(id);
    return node;
  }

  /**
   * The node's bounds once it holds still. A node where the observation saw
   * it is acted on at once; one that moved since (a row in a list still
   * coasting after a fling) is read until two reads a frame apart agree, so
   * the touch lands on the node and not on the one passing under it.
   */
  private Rect settledBounds(AccessibilityNodeInfo node, String id, Operation operation) throws EngineException {
    Rect current = new Rect();
    node.getBoundsInScreen(current);
    if (current.equals(observedBounds.get(id))) return current;
    long deadline = SystemClock.uptimeMillis() + Math.min(2000, operation.timeoutMs);
    while (SystemClock.uptimeMillis() < deadline) {
      pause(32, operation);
      if (!node.refresh()) throw EngineException.stale(id);
      Rect next = new Rect();
      node.getBoundsInScreen(next);
      if (next.equals(current)) return next;
      current = next;
    }
    return current;
  }

  private float[] actionable(Rect bounds, String id) throws EngineException {
    Point size = displaySize();
    Rect visible = new Rect(bounds);
    if (!visible.intersect(0, 0, size.x, size.y) || visible.isEmpty()) {
      throw EngineException.notActionable("node " + id + " is off screen");
    }
    return new float[] {visible.exactCenterX(), visible.exactCenterY()};
  }

  private void setText(AccessibilityNodeInfo node, String value) throws EngineException {
    Bundle arguments = new Bundle();
    arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
    if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) {
      throw EngineException.notActionable("the field refused the text");
    }
  }

  private void tap(float[] point) throws EngineException {
    long down = SystemClock.uptimeMillis();
    touch(down, down, MotionEvent.ACTION_DOWN, point[0], point[1]);
    touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, point[0], point[1]);
  }

  private void longPress(float[] point, long durationMs, Operation operation) throws EngineException {
    long down = SystemClock.uptimeMillis();
    touch(down, down, MotionEvent.ACTION_DOWN, point[0], point[1]);
    try {
      pause(durationMs, operation);
    } finally {
      // The finger always lifts, even from an abandoned press.
      touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, point[0], point[1]);
    }
  }

  private void drag(float[] from, float[] to, Operation operation) throws EngineException {
    gesture(from, to, 400, ViewConfiguration.getLongPressTimeout() + 200, false, operation);
  }

  /**
   * A scroll gesture inside `bounds`: `down` reveals what is below, so the
   * finger travels up. `none` drags and rests before lifting; `slow` slows
   * down toward the end, as a hand does, so the content coasts a little;
   * `fast` lifts at full speed, a long fling.
   */
  private void swipe(Rect bounds, String direction, String momentum, Operation operation) throws EngineException {
    float cx = bounds.exactCenterX();
    float cy = bounds.exactCenterY();
    float dx = bounds.width() * 0.3f;
    float dy = bounds.height() * 0.3f;
    float[] from;
    float[] to;
    switch (direction) {
      case "down":
        from = new float[] {cx, cy + dy};
        to = new float[] {cx, cy - dy};
        break;
      case "up":
        from = new float[] {cx, cy - dy};
        to = new float[] {cx, cy + dy};
        break;
      case "right":
        from = new float[] {cx + dx, cy};
        to = new float[] {cx - dx, cy};
        break;
      case "left":
        from = new float[] {cx - dx, cy};
        to = new float[] {cx + dx, cy};
        break;
      default:
        throw EngineException.unsupported("unknown swipe direction " + direction);
    }
    long duration = "fast".equals(momentum) ? 120 : 400;
    gestureToRest(from, to, duration, "none".equals(momentum) ? 0 : -1, "slow".equals(momentum), operation);
  }

  /** Runs a gesture, then waits for what it set moving to come to rest. */
  private void gestureToRest(float[] from, float[] to, long durationMs, long holdMs, boolean easeOut, Operation operation) throws EngineException {
    AtomicReference<AccessibilityNodeInfo> scrolled = new AtomicReference<>();
    automation.setOnAccessibilityEventListener(event -> {
      if (event.getEventType() != AccessibilityEvent.TYPE_VIEW_SCROLLED) return;
      AccessibilityNodeInfo source = event.getSource();
      if (source != null) scrolled.set(source);
    });
    try {
      gesture(from, to, durationMs, holdMs, easeOut, operation);
      awaitRest(scrolled.get(), operation);
    } finally {
      automation.setOnAccessibilityEventListener(null);
    }
  }

  /**
   * Waits for content a gesture set moving to come to rest: a list coasts
   * after the finger lifts, and a touch on it then stops the fling instead
   * of pressing what is under it. A container that scrolled is read every
   * frame until its content holds still for four frames. Content that moved
   * without scrolling (an animated view) only raises accessibility events,
   * so a pause in them is its rest.
   */
  private void awaitRest(AccessibilityNodeInfo scrolled, Operation operation) throws EngineException {
    long timeoutMs = Math.min(3000, operation.timeoutMs);
    if (scrolled == null) {
      try {
        automation.waitForIdle(150, timeoutMs);
      } catch (java.util.concurrent.TimeoutException ignored) {
        // Content that never rests (an animation) is acted on as it is.
      }
      return;
    }
    long deadline = SystemClock.uptimeMillis() + timeoutMs;
    String last = layout(scrolled);
    for (int still = 0; last != null && still < 4 && SystemClock.uptimeMillis() < deadline; ) {
      pause(16, operation);
      String next = layout(scrolled);
      still = last.equals(next) ? still + 1 : 0;
      last = next;
    }
  }

  /** Where a scroll container's content is on screen, up to three levels down; null once it left the screen. */
  private static String layout(AccessibilityNodeInfo container) {
    if (!container.refresh()) return null;
    StringBuilder out = new StringBuilder();
    appendLayout(container, 0, out, new int[] {0});
    return out.toString();
  }

  private static void appendLayout(AccessibilityNodeInfo node, int depth, StringBuilder out, int[] count) {
    Rect bounds = new Rect();
    for (int index = 0; index < node.getChildCount() && count[0] < 24; index++) {
      AccessibilityNodeInfo child = node.getChild(index);
      if (child == null) continue;
      child.getBoundsInScreen(bounds);
      out.append(bounds.toShortString());
      count[0] += 1;
      if (depth < 2) appendLayout(child, depth + 1, out, count);
    }
  }

  /**
   * A finger moving from `from` to `to` over `durationMs`. `holdMs` above
   * zero holds before moving (a drag); zero rests at the end before lifting,
   * so nothing flings; below zero lifts while moving, a fling. `easeOut`
   * slows the finger toward the end, so the fling is short. Only the down
   * and up wait for delivery: the dispatcher keeps the moves in order. An
   * abandoned gesture still lifts the finger where it is.
   */
  private void gesture(float[] from, float[] to, long durationMs, long holdMs, boolean easeOut, Operation operation) throws EngineException {
    long down = SystemClock.uptimeMillis();
    float[] at = {from[0], from[1]};
    touch(down, down, MotionEvent.ACTION_DOWN, at[0], at[1]);
    try {
      if (holdMs > 0) pause(holdMs, operation);
      int steps = Math.max(5, (int) (durationMs / 16));
      long start = SystemClock.uptimeMillis();
      for (int step = 1; step <= steps; step++) {
        float linear = (float) step / steps;
        float fraction = easeOut ? 1 - (1 - linear) * (1 - linear) * (1 - linear) : linear;
        long wait = start + (durationMs * step) / steps - SystemClock.uptimeMillis();
        if (wait > 0) pause(wait, operation);
        at = new float[] {from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction};
        touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, at[0], at[1], false);
      }
      if (holdMs == 0) pause(50, operation);
    } finally {
      touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, at[0], at[1]);
    }
  }

  private void touch(long downTime, long eventTime, int action, float x, float y) throws EngineException {
    touch(downTime, eventTime, action, x, y, true);
  }

  /** Injects one touch event; with `sync`, returns once the app received it. */
  private void touch(long downTime, long eventTime, int action, float x, float y, boolean sync) throws EngineException {
    MotionEvent event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0);
    event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    try {
      if (!automation.injectInputEvent(event, sync)) throw EngineException.failure("the touch was not delivered");
    } finally {
      event.recycle();
    }
  }

  private void pressCode(int code) throws EngineException {
    long now = SystemClock.uptimeMillis();
    inject(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
    inject(new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
  }

  private void inject(KeyEvent event) throws EngineException {
    if (!automation.injectInputEvent(event, true)) throw EngineException.failure("the key was not delivered");
  }

  /** After an agent's action, waits for the app to go quiet so the next observation shows the outcome. */
  private void settle(Operation operation) {
    if (!operation.agent) return;
    try {
      automation.waitForIdle(100, Math.min(2000, operation.timeoutMs));
    } catch (java.util.concurrent.TimeoutException ignored) {
      // A screen that never idles (an animation) is observed as it is.
    }
  }



  private Point displaySize() {
    Point size = new Point();
    ((WindowManager) context.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealSize(size);
    return size;
  }

  /** Runs a shell command as the shell user and returns its output once it exits. */
  private String shell(String command) throws IOException {
    ParcelFileDescriptor descriptor = automation.executeShellCommand(command);
    try (InputStream input = new FileInputStream(descriptor.getFileDescriptor())) {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      int read;
      while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
      return output.toString("UTF-8");
    } finally {
      descriptor.close();
    }
  }

  /** The regions of both scans, each once: the count reports what was painted. */
  private static List<Rect> union(List<Rect> first, List<Rect> second) {
    List<Rect> regions = new ArrayList<>(first);
    for (Rect region : second) if (!regions.contains(region)) regions.add(region);
    return regions;
  }

  /** Every secure field on screen, with no node cap: what a capture must mask. */
  private List<Rect> secureFields() {
    List<Rect> fields = new ArrayList<>();
    for (AccessibilityWindowInfo window : automation.getWindows()) {
      AccessibilityNodeInfo root = window.getRoot();
      if (root != null) collectSecure(root, 0, fields);
    }
    return fields;
  }

  private static void collectSecure(AccessibilityNodeInfo node, int depth, List<Rect> fields) {
    if (node.isPassword()) {
      Rect bounds = new Rect();
      node.getBoundsInScreen(bounds);
      fields.add(bounds);
    }
    if (depth > 1024) return;
    for (int index = 0; index < node.getChildCount(); index++) {
      AccessibilityNodeInfo child = node.getChild(index);
      if (child != null) collectSecure(child, depth + 1, fields);
    }
  }

  /** Paints `fields` over a capture, so no password leaves the device. */
  private static Bitmap masked(Bitmap capture, List<Rect> fields) {
    if (capture == null || fields.isEmpty()) return capture;
    Bitmap bitmap = capture.copy(Bitmap.Config.ARGB_8888, true);
    capture.recycle();
    Canvas canvas = new Canvas(bitmap);
    Paint paint = new Paint();
    paint.setColor(Color.BLACK);
    for (Rect bounds : fields) canvas.drawRect(bounds, paint);
    return bitmap;
  }

  private static String encodePng(Bitmap bitmap) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, output);
    return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
  }

  private static JSONObject ref(String id) throws JSONException {
    JSONObject ref = new JSONObject();
    ref.put("id", id);
    ref.put("revision", "");
    return ref;
  }

  private static JSONObject rect(int x, int y, int width, int height) throws JSONException {
    JSONObject rect = new JSONObject();
    rect.put("x", x);
    rect.put("y", y);
    rect.put("width", width);
    rect.put("height", height);
    return rect;
  }

  private static String nonEmpty(CharSequence value) {
    if (value == null) return null;
    String text = value.toString();
    return text.isEmpty() ? null : text;
  }

  private static String cut(String value, int limit) {
    return value.length() <= limit ? value : value.substring(0, limit);
  }
}
