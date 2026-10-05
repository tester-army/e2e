import { useState } from 'react';
import { Image, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { DMMono_400Regular } from '@expo-google-fonts/dm-mono/400Regular';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { StackSansNotch_400Regular } from '@expo-google-fonts/stack-sans-notch/400Regular';

export default function App() {
  const [fontsLoaded] = useFonts({ DMMono_400Regular, Inter_400Regular, StackSansNotch_400Regular });
  const [name, setName] = useState('');
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
        <Image source={require('./assets/helmet-mark.png')} style={styles.mark} accessible={false} accessibilityElementsHidden importantForAccessibility="no" />
        <Text style={styles.slash}>/</Text>
        <Text style={styles.wordmark}>e2e</Text>
      </View>

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>[01] with-expo</Text>
        <Text style={styles.title} accessibilityRole="header">
          Say hello
        </Text>
        <Text style={styles.lede}>A demo screen for the e2e examples. Type a name and the app greets you.</Text>

        <View style={styles.form}>
          <Text style={styles.label}>Name</Text>
          {/* testID is what getByTestId finds: the accessibility identifier on iOS, the resource id on Android. */}
          <TextInput
            testID="name"
            accessibilityLabel="Name"
            style={styles.field}
            value={name}
            onChangeText={setName}
            placeholder="Ada Lovelace"
            placeholderTextColor="#ffffff80"
            autoCorrect={false}
            onSubmitEditing={greet}
          />
          <Pressable testID="greet" accessibilityRole="button" style={styles.button} onPress={greet}>
            <Text style={styles.buttonLabel}>Greet</Text>
          </Pressable>
          {error ? (
            <Text testID="error" style={styles.error} accessibilityRole="alert">
              Enter a name first.
            </Text>
          ) : null}
          {greeted !== null ? (
            <Text testID="greeting" style={styles.status}>
              Hello, {greeted}!
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// e2e brand: dark canvas, square corners, hairlines instead of shadows, white text at falling alphas.
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#111111', paddingHorizontal: 24 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 72,
    paddingBottom: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ffffff1f',
  },
  mark: { width: 32, height: 32 },
  slash: { color: '#f9f8f7', fontFamily: 'DMMono_400Regular', fontSize: 26 },
  wordmark: { color: '#f9f8f7', fontFamily: 'StackSansNotch_400Regular', fontSize: 26, letterSpacing: -1.5 },
  hero: { gap: 16, paddingTop: 48 },
  eyebrow: {
    color: '#ffffffb3',
    fontFamily: 'DMMono_400Regular',
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  title: { color: '#f9f8f7', fontFamily: 'StackSansNotch_400Regular', fontSize: 38, lineHeight: 43 },
  lede: { color: '#ffffffb3', fontFamily: 'Inter_400Regular', fontSize: 16, lineHeight: 24 },
  form: { gap: 12, paddingTop: 24 },
  label: {
    color: '#ffffff80',
    fontFamily: 'DMMono_400Regular',
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  field: {
    height: 44,
    paddingHorizontal: 12,
    backgroundColor: '#1a1a1a',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff4d',
    color: '#f9f8f7',
    fontFamily: 'DMMono_400Regular',
    fontSize: 14,
  },
  button: { height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f9f8f7' },
  buttonLabel: { color: '#161616', fontFamily: 'DMMono_400Regular', fontSize: 13, textTransform: 'uppercase' },
  error: { color: '#ff8001', fontFamily: 'Inter_400Regular', fontSize: 14 },
  status: {
    padding: 14,
    backgroundColor: '#161616',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ffffff1f',
    color: '#f9f8f7',
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    lineHeight: 20,
  },
});
