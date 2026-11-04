import { useState } from 'react';
import { Image, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';

export default function App() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, JetBrainsMono_400Regular });
  const [name, setName] = useState('');
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState(false);
  const [greeted, setGreeted] = useState<string | null>(null);

  function greet() {
    Keyboard.dismiss();
    const value = name.trim();
    if (value === '') {
      setError(true);
      setGreeted(null);
      return;
    }
    setError(false);
    setGreeted(value);
    setName('');
  }

  if (!fontsLoaded) return <View style={styles.page} />;

  return (
    <View style={styles.page}>
      <StatusBar style="light" />

      <View style={styles.nav}>
        <Image
          source={require('./assets/e2e-logotype.png')}
          style={styles.logo}
          accessible
          accessibilityRole="image"
          accessibilityLabel="e2e"
        />
      </View>

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>[ with-expo ]</Text>
        <Text style={styles.title} accessibilityRole="header">
          say hello
        </Text>
        <Text style={styles.lede}>A demo screen for the e2e examples. Type a name and the app greets you.</Text>

        <View style={styles.form}>
          <View style={[styles.field, focused && styles.fieldFocused, error && styles.fieldInvalid]}>
            {/* The field carries the name for assistive tech, so the visible label stays out of the tree. */}
            <Text style={styles.label} accessibilityElementsHidden importantForAccessibility="no">
              name
            </Text>
            {/* testID is what getByTestId finds: the accessibility identifier on iOS, the resource id on Android. */}
            <TextInput
              testID="name"
              accessibilityLabel="name"
              style={styles.input}
              value={name}
              onChangeText={setName}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              selectionColor="#f7f7f7"
              underlineColorAndroid="transparent"
              autoCorrect={false}
              onSubmitEditing={greet}
            />
          </View>
          <Pressable
            testID="greet"
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={greet}
          >
            <Text style={styles.buttonLabel}>greet</Text>
          </Pressable>
          {error ? (
            <Text testID="error" style={styles.error} accessibilityRole="alert">
              enter a name first.
            </Text>
          ) : null}
          {greeted !== null ? (
            <Text testID="greeting" style={styles.status}>
              hello, {greeted}!
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// e2e design system: black canvas, square corners, e2e blue for the one action, green and mint
// accents, an 8px spacing grid, and lowercase headings and UI. Inter and JetBrains Mono stand in
// for the brand's own typefaces.
const color = {
  black: '#000000',
  offWhite: '#f7f7f7',
  neutral800: '#1c1c1c',
  neutral500: '#8d8d8d',
  neutral400: '#b1b1b1',
  blue: '#1a5fff',
  green: '#64ff9d',
  mint: '#8af9ff',
};
const sans = 'Inter_400Regular';
const mono = 'JetBrainsMono_400Regular';

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.black, paddingHorizontal: 24 },
  nav: {
    paddingTop: 64,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.neutral800,
  },
  logo: { width: 69, height: 24 },
  hero: { paddingTop: 48 },
  eyebrow: { color: color.green, fontFamily: mono, fontSize: 12, lineHeight: 14, letterSpacing: 0.48 },
  title: {
    marginTop: 8,
    color: color.offWhite,
    fontFamily: sans,
    fontSize: 39,
    lineHeight: 44,
    letterSpacing: -1.17,
  },
  lede: { marginTop: 24, color: color.neutral500, fontFamily: sans, fontSize: 18, lineHeight: 25 },
  form: { gap: 16, marginTop: 40 },
  // The design system's text field: the label sits inside the field, above the value. The border is
  // always 2 wide, so focus and the error only change its colour and nothing moves.
  field: { height: 56, backgroundColor: color.neutral800, borderWidth: 2, borderColor: 'transparent' },
  fieldFocused: { borderColor: color.green },
  fieldInvalid: { borderColor: color.mint },
  label: {
    position: 'absolute',
    top: 4,
    left: 14,
    color: color.neutral400,
    fontFamily: mono,
    fontSize: 12,
    lineHeight: 15,
  },
  input: {
    flex: 1,
    paddingTop: 18,
    paddingBottom: 6,
    paddingHorizontal: 14,
    color: color.offWhite,
    fontFamily: sans,
    fontSize: 16,
  },
  // Buttons change no colour when pressed or hovered; a press scales them a little.
  button: { height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: color.blue },
  buttonPressed: { transform: [{ scale: 0.98 }] },
  buttonLabel: { color: color.offWhite, fontFamily: mono, fontSize: 15 },
  error: { color: color.mint, fontFamily: sans, fontSize: 14, lineHeight: 20 },
  status: {
    padding: 16,
    backgroundColor: color.neutral800,
    color: color.offWhite,
    fontFamily: sans,
    fontSize: 16,
    lineHeight: 22,
  },
});
