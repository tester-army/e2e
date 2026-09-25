import * as LocalAuthentication from "expo-local-authentication";
import * as Location from "expo-location";
import { useNetworkState } from "expo-network";
import { useEffect, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";

const SECTIONS = ["Fields", "Toggles", "Gestures", "Device"] as const;
type Section = (typeof SECTIONS)[number];
const SIZES = ["Small", "Medium", "Large"] as const;
const FRUITS = [
  { name: "Apple", price: "$1" },
  { name: "Banana", price: "$2" },
  { name: "Cherry", price: "$3" },
] as const;
const DOUBLE_TAP_WINDOW_MS = 300;
const DELAYED_BUTTON_MS = 1500;

/**
 * Formats a point relative to a control as the app prints it.
 */
const formatPoint = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;

/**
 * The deterministic contract surface: plain controls with every state exposed
 * through accessibility props, so each runner verb has a device exercise. Not
 * a hard surface. Four sections behind a tab row keep every control on
 * screen without scrolling; the header and the environment lines stay above.
 */
export default function ControlInventory() {
  const [section, setSection] = useState<Section>("Fields");
  const colorScheme = useColorScheme();
  const { width, height } = useWindowDimensions();

  return (
    <ScrollView
      testID="inventory-scroll"
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <Text
        testID="inventory-header"
        accessibilityRole="header"
        accessibilityLabel="Inventory heading"
        style={styles.header}
      >
        Plain controls, every state exposed
      </Text>
      <Text testID="color-scheme" style={styles.status}>
        scheme: {colorScheme ?? "unknown"}
      </Text>
      <Text testID="orientation" style={styles.status}>
        orientation: {width > height ? "landscape" : "portrait"}
      </Text>
      <Text testID="window-size" style={styles.status}>
        {Math.round(width)}x{Math.round(height)}
      </Text>

      <View testID="section-tabs" accessibilityRole="tablist" style={styles.row}>
        {SECTIONS.map((name) => (
          <Pressable
            key={name}
            testID={`tab-${name.toLowerCase()}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: section === name }}
            style={[styles.chip, section === name && styles.chipSelected]}
            onPress={() => setSection(name)}
          >
            <Text style={[styles.chipText, section === name && styles.chipTextSelected]}>{name}</Text>
          </Pressable>
        ))}
      </View>

      {section === "Fields" && <FieldsSection />}
      {section === "Toggles" && <TogglesSection />}
      {section === "Gestures" && <GesturesSection />}
      {section === "Device" && <DeviceSection />}
    </ScrollView>
  );
}

/**
 * Text inputs: a labeled field with a placeholder and a default value, a
 * secure field, and a field echoing the last key. A button swaps them for two
 * fields whose first one autofocuses when it mounts, kept at the top so the
 * keyboard never covers the focus status.
 */
function FieldsSection() {
  const [name, setName] = useState("Ada Lovelace");
  const [passphrase, setPassphrase] = useState("");
  const [lastKey, setLastKey] = useState("none");
  const [focusShown, setFocusShown] = useState(false);
  const [focused, setFocused] = useState("none");
  const autofocusRef = useRef<TextInput>(null);

  // `autoFocus` alone does not take when the field mounts from a press on
  // this screen; the next frame's focus() does.
  useEffect(() => {
    if (!focusShown) return;
    const frame = requestAnimationFrame(() => autofocusRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusShown]);

  /**
   * Clears the focus status only when the field losing focus still owns it,
   * whichever order the platform fires blur and focus in.
   */
  const blurred = (field: string) => () => {
    setFocused((current) => (current === field ? "none" : current));
  };

  if (focusShown) {
    return (
      <View style={styles.section}>
        <TextInput
          ref={autofocusRef}
          testID="autofocus-input"
          accessibilityLabel="Autofocus field"
          autoFocus
          style={styles.input}
          onFocus={() => setFocused("Autofocus field")}
          onBlur={blurred("Autofocus field")}
        />
        <TextInput
          testID="second-input"
          accessibilityLabel="Second field"
          style={styles.input}
          onFocus={() => setFocused("Second field")}
          onBlur={blurred("Second field")}
        />
        <Text testID="focus-status" style={styles.status}>
          focus: {focused}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <TextInput
        testID="name-input"
        accessibilityLabel="Name field"
        placeholder="Type your name"
        defaultValue="Ada Lovelace"
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setName}
      />
      <Text testID="name-echo" style={styles.status}>
        name: {name}
      </Text>

      <TextInput
        testID="passphrase-input"
        accessibilityLabel="Passphrase field"
        placeholder="Passphrase"
        secureTextEntry
        style={styles.input}
        onChangeText={setPassphrase}
      />
      <Text testID="passphrase-length" style={styles.status}>
        passphrase length: {passphrase.length}
      </Text>

      <TextInput
        testID="key-input"
        accessibilityLabel="Key echo field"
        placeholder="Key echo"
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        onKeyPress={(event) => setLastKey(event.nativeEvent.key)}
        onSubmitEditing={() => setLastKey("Enter")}
      />
      <Text testID="key-status" style={styles.status}>
        key: {lastKey}
      </Text>

      <TouchableOpacity
        testID="show-focus-fields"
        accessibilityRole="button"
        style={styles.button}
        onPress={() => setFocusShown(true)}
      >
        <Text style={styles.buttonText}>Show focus fields</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * Stateful controls: a switch, a checkbox, a radio group, a disabled button,
 * a button that enables itself after mount, and a hidden text with a visible
 * twin. Every state change echoes into a status line.
 */
function TogglesSection() {
  const [wifi, setWifi] = useState(false);
  const [newsletter, setNewsletter] = useState(false);
  const [size, setSize] = useState<string>("Small");
  const [delayed, setDelayed] = useState<"arming" | "ready" | "pressed">("arming");

  useEffect(() => {
    const timer = setTimeout(() => setDelayed("ready"), DELAYED_BUTTON_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.section}>
      <View style={styles.switchRow}>
        <Text style={styles.label}>Wi-Fi</Text>
        <Switch testID="wifi-switch" accessibilityLabel="Wi-Fi switch" value={wifi} onValueChange={setWifi} />
      </View>
      <Text testID="wifi-status" style={styles.status}>
        wifi: {wifi ? "on" : "off"}
      </Text>

      <Pressable
        testID="newsletter-checkbox"
        accessibilityRole="checkbox"
        accessibilityLabel="Newsletter"
        accessibilityState={{ checked: newsletter }}
        style={styles.checkboxRow}
        onPress={() => setNewsletter((current) => !current)}
      >
        <View style={[styles.checkbox, newsletter && styles.checkboxChecked]}>
          {newsletter && <Text style={styles.checkboxMark}>✓</Text>}
        </View>
        <Text style={styles.label}>Newsletter</Text>
      </Pressable>
      <Text testID="newsletter-status" style={styles.status}>
        newsletter: {newsletter ? "on" : "off"}
      </Text>

      <View testID="size-group" accessibilityRole="radiogroup" style={styles.row}>
        {SIZES.map((option) => (
          <Pressable
            key={option}
            testID={`size-${option.toLowerCase()}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: size === option, checked: size === option }}
            style={[styles.chip, size === option && styles.chipSelected]}
            onPress={() => setSize(option)}
          >
            <Text style={[styles.chipText, size === option && styles.chipTextSelected]}>
              {option}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text testID="size-status" style={styles.status}>
        size: {size}
      </Text>

      <View style={styles.row}>
        <TouchableOpacity
          testID="locked-button"
          accessibilityRole="button"
          disabled
          style={[styles.button, styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>Locked</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="delayed-button"
          accessibilityRole="button"
          disabled={delayed === "arming"}
          style={[styles.button, delayed === "arming" && styles.buttonDisabled]}
          onPress={() => setDelayed("pressed")}
        >
          <Text style={styles.buttonText}>Delayed</Text>
        </TouchableOpacity>
      </View>
      <Text testID="delayed-status" style={styles.status}>
        delayed: {delayed}
      </Text>

      <Text testID="ghost-text" style={[styles.status, styles.hidden]}>
        Now you see me
      </Text>
      <Text testID="twin-text" style={styles.status}>
        Now you see me
      </Text>
    </View>
  );
}

/**
 * Pointer surfaces: a long-press target and a double-tap target that echo the
 * gesture, a pad that reports the tapped point relative to itself, a pad that
 * reports a swipe's start and end, and a three-row list.
 */
function GesturesSection() {
  const [gesture, setGesture] = useState("none");
  const [taps, setTaps] = useState("0 taps");
  const [pad, setPad] = useState("none");
  const [swipe, setSwipe] = useState("none");
  const lastTapRef = useRef(0);
  const tapCountRef = useRef(0);
  const swipeStartRef = useRef({ x: 0, y: 0 });

  /**
   * Detects a double tap from consecutive presses and reports the count and
   * the gap, so a pair that missed the window still shows what arrived.
   */
  const handleDoubleTapCandidate = () => {
    const now = Date.now();
    const gap = now - lastTapRef.current;
    lastTapRef.current = now;
    tapCountRef.current += 1;
    setTaps(tapCountRef.current === 1 ? "1 tap" : `${tapCountRef.current} taps, ${gap} ms apart`);
    setGesture(tapCountRef.current > 1 && gap <= DOUBLE_TAP_WINDOW_MS ? "double tap" : "single tap");
  };

  /**
   * Reports where a tap landed, relative to the pad's top-left corner.
   */
  const handlePadPress = (event: GestureResponderEvent) => {
    setPad(formatPoint(event.nativeEvent.locationX, event.nativeEvent.locationY));
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        swipeStartRef.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
      },
      onPanResponderRelease: (_event, gestureState) => {
        const from = swipeStartRef.current;
        setSwipe(
          `${formatPoint(from.x, from.y)} to ${formatPoint(from.x + gestureState.dx, from.y + gestureState.dy)}`,
        );
      },
    }),
  ).current;

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Pressable
          testID="long-press-target"
          accessibilityRole="button"
          style={styles.target}
          delayLongPress={500}
          onLongPress={() => setGesture("long press")}
          onPress={() => setGesture("short press")}
        >
          <Text style={styles.buttonText}>Hold me</Text>
        </Pressable>
        <Pressable
          testID="double-tap-target"
          accessibilityRole="button"
          style={styles.target}
          onPress={handleDoubleTapCandidate}
        >
          <Text style={styles.buttonText}>Double-tap me</Text>
        </Pressable>
      </View>
      <Text testID="gesture-status" style={styles.status}>
        gesture: {gesture}
      </Text>
      <Text testID="tap-count" style={styles.status}>
        {taps}
      </Text>

      <Pressable testID="tap-pad" accessibilityLabel="Tap pad" style={styles.pad} onPress={handlePadPress} />
      <Text testID="pad-status" style={styles.status}>
        pad: {pad}
      </Text>

      <View testID="swipe-pad" accessibilityLabel="Swipe pad" style={styles.swipePad} {...panResponder.panHandlers} />
      <Text testID="swipe-status" style={styles.status}>
        swipe: {swipe}
      </Text>

      <View testID="fruit-list" accessibilityRole="list" style={styles.list}>
        {FRUITS.map((fruit) => (
          <View key={fruit.name} testID="fruit-row" style={styles.listRow}>
            <Text style={styles.listText}>{fruit.name}</Text>
            <Text style={styles.listPrice}>{fruit.price}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * What the device tells the app: the network state as it changes, the
 * position a button reads, and a biometric prompt a button raises. Each line
 * is the readback for one `device` fixture method that has no other surface.
 */
function DeviceSection() {
  const network = useNetworkState();
  const [location, setLocation] = useState("location: not read");
  const [biometrics, setBiometrics] = useState("biometrics: idle");
  const readRef = useRef(0);

  /**
   * Reads the current position once permission is granted and prints it to
   * four decimals, the precision a fixture sets it with. Only the newest read
   * reports: an older one finishing last would print a fix the fixture has
   * since moved.
   */
  const readLocation = async () => {
    readRef.current += 1;
    const read = readRef.current;
    const report = (text: string) => {
      if (readRef.current === read) setLocation(text);
    };
    report("location: reading");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        report("location: permission denied");
        return;
      }
      // Highest accuracy reads the GPS provider, the one an emulator's fix feeds;
      // Android otherwise offers Google's "Location Accuracy" dialog over the app on the first read.
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest, mayShowUserSettingsDialog: false });
      report(`location: ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`);
    } catch (error) {
      report(`location: unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  /**
   * Raises the biometric prompt and prints its outcome; without an enrolled
   * sensor there is no prompt to raise.
   */
  const unlock = async () => {
    setBiometrics("biometrics: authenticating");
    try {
      if (!(await LocalAuthentication.isEnrolledAsync())) {
        setBiometrics("biometrics: not enrolled");
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({ disableDeviceFallback: true, cancelLabel: "Cancel" });
      setBiometrics(result.success ? "biometrics: unlocked" : `biometrics: failed (${result.error})`);
    } catch {
      setBiometrics("biometrics: unavailable");
    }
  };

  const connected = network.isConnected === undefined ? "unknown" : network.isConnected ? "connected" : "disconnected";
  return (
    <View style={styles.section}>
      <Text testID="network-state" style={styles.status}>
        network: {connected}
      </Text>
      <View style={styles.row}>
        <TouchableOpacity testID="read-location" accessibilityRole="button" style={styles.button} onPress={() => void readLocation()}>
          <Text style={styles.buttonText}>Read location</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="unlock-biometrics" accessibilityRole="button" style={styles.button} onPress={() => void unlock()}>
          <Text style={styles.buttonText}>Unlock with biometrics</Text>
        </TouchableOpacity>
      </View>
      <Text testID="location-status" style={styles.status}>
        {location}
      </Text>
      <Text testID="biometrics-status" style={styles.status}>
        {biometrics}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 8,
  },
  header: {
    fontSize: 18,
    fontWeight: "600",
  },
  status: {
    fontSize: 14,
    color: "#666",
  },
  hidden: {
    display: "none",
  },
  section: {
    gap: 8,
    marginTop: 4,
  },
  label: {
    fontSize: 15,
    fontWeight: "500",
  },
  row: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  chip: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  chipSelected: {
    backgroundColor: "#111",
    borderColor: "#111",
  },
  chipText: {
    fontSize: 15,
  },
  chipTextSelected: {
    color: "#fff",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 4,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#999",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: "#111",
    borderColor: "#111",
  },
  checkboxMark: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: "center",
  },
  buttonDisabled: {
    backgroundColor: "#bbb",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  target: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  pad: {
    width: 240,
    height: 100,
    borderRadius: 8,
    backgroundColor: "#dfe8f6",
  },
  swipePad: {
    height: 80,
    borderRadius: 8,
    backgroundColor: "#e8f6df",
  },
  list: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d0d0d0",
    borderRadius: 8,
  },
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d0d0d0",
  },
  listText: {
    fontSize: 16,
  },
  listPrice: {
    fontSize: 16,
    color: "#666",
  },
});
