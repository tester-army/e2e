import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

void main() {
  runApp(const GreeterApp());
}

class GreeterApp extends StatelessWidget {
  const GreeterApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'with-flutter',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Brand.canvas,
        textSelectionTheme: const TextSelectionThemeData(
          cursorColor: Brand.textPrimary,
        ),
      ),
      home: const GreetingScreen(),
    );
  }
}

class GreetingScreen extends StatefulWidget {
  const GreetingScreen({super.key});

  @override
  State<GreetingScreen> createState() => _GreetingScreenState();
}

class _GreetingScreenState extends State<GreetingScreen> {
  final _name = TextEditingController();
  bool _showError = false;
  String? _greeted;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _greet() {
    FocusScope.of(context).unfocus();
    final value = _name.text.trim();
    setState(() {
      if (value.isEmpty) {
        _showError = true;
        _greeted = null;
        return;
      }
      _showError = false;
      _greeted = value;
      _name.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    // Light status bar icons over the dark canvas.
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 20),
                  child: Row(
                    children: [
                      Image.asset(
                        'assets/helmet-mark.png',
                        width: 32,
                        height: 32,
                        excludeFromSemantics: true,
                      ),
                      const SizedBox(width: 10),
                      Text('/', style: Brand.mono(26, Brand.textPrimary)),
                      const SizedBox(width: 10),
                      Text(
                        'e2e',
                        style: Brand.display(26).copyWith(letterSpacing: -1.5),
                      ),
                    ],
                  ),
                ),
                Container(height: 0.5, color: Brand.hairline),
                const SizedBox(height: 48),
                Text(
                  '[01] with-flutter'.toUpperCase(),
                  style: Brand.mono(
                    12,
                    Brand.textSecondary,
                    letterSpacing: 0.6,
                  ),
                ),
                const SizedBox(height: 16),
                Semantics(
                  header: true,
                  child: Text(
                    'Say hello',
                    style: Brand.display(38).copyWith(height: 43 / 38),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  'A demo screen for the e2e examples. Type a name and the app greets you.',
                  style: Brand.sans(
                    16,
                    Brand.textSecondary,
                  ).copyWith(height: 24 / 16),
                ),
                const SizedBox(height: 40),
                Text(
                  'NAME',
                  style: Brand.mono(11, Brand.textFaint, letterSpacing: 1.1),
                ),
                const SizedBox(height: 12),
                // identifier is what getByTestId finds: the resource id on Android,
                // the accessibility identifier on iOS.
                Semantics(
                  identifier: 'name',
                  // The hint is not a name; without this the field reads as an unnamed textbox.
                  label: 'Name',
                  child: SizedBox(
                    height: 48,
                    child: TextField(
                      controller: _name,
                      autocorrect: false,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _greet(),
                      style: Brand.mono(14, Brand.textPrimary),
                      decoration: InputDecoration(
                        hintText: 'Ada Lovelace',
                        hintStyle: Brand.mono(14, Brand.textFaint),
                        filled: true,
                        fillColor: Brand.fieldFill,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 12,
                        ),
                        enabledBorder: const OutlineInputBorder(
                          borderRadius: BorderRadius.zero,
                          borderSide: BorderSide(
                            color: Brand.fieldStroke,
                            width: 0.5,
                          ),
                        ),
                        focusedBorder: const OutlineInputBorder(
                          borderRadius: BorderRadius.zero,
                          borderSide: BorderSide(
                            color: Brand.textPrimary,
                            width: 0.5,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                // MergeSemantics folds the identifier into the button's own node.
                MergeSemantics(
                  child: Semantics(
                    identifier: 'greet',
                    child: SizedBox(
                      width: double.infinity,
                      height: 48,
                      child: TextButton(
                        onPressed: _greet,
                        style: TextButton.styleFrom(
                          backgroundColor: Brand.buttonFill,
                          foregroundColor: Brand.textOnLight,
                          shape: const RoundedRectangleBorder(),
                          textStyle: Brand.mono(13, Brand.textOnLight),
                        ),
                        child: const Text('GREET'),
                      ),
                    ),
                  ),
                ),
                if (_showError) ...[
                  const SizedBox(height: 12),
                  Semantics(
                    identifier: 'error',
                    container: true,
                    // TalkBack and VoiceOver read the error when it appears.
                    liveRegion: true,
                    child: Text(
                      'Enter a name first.',
                      style: Brand.sans(14, Brand.accent),
                    ),
                  ),
                ],
                if (_greeted case final greeted?) ...[
                  const SizedBox(height: 12),
                  Semantics(
                    identifier: 'greeting',
                    container: true,
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: Brand.panel,
                        border: Border.all(color: Brand.hairline, width: 0.5),
                      ),
                      child: Text(
                        'Hello, $greeted!',
                        style: Brand.sans(
                          14,
                          Brand.textPrimary,
                        ).copyWith(height: 20 / 14),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// e2e brand: dark canvas, square corners, hairlines instead of shadows, white text at falling alphas.
abstract final class Brand {
  static const canvas = Color(0xFF111111);
  static const panel = Color(0xFF161616);
  static const fieldFill = Color(0xFF1A1A1A);
  static const buttonFill = Color(0xFFF9F8F7);
  static const textPrimary = Color(0xFFF9F8F7);
  static const textOnLight = Color(0xFF161616);
  static const textSecondary = Color(0xB3FFFFFF);
  static const textFaint = Color(0x80FFFFFF);
  static const hairline = Color(0x1FFFFFFF);
  static const fieldStroke = Color(0x4DFFFFFF);
  static const accent = Color(0xFFFF8001);

  static TextStyle display(double size) => TextStyle(
    fontFamily: 'StackSansNotch',
    fontSize: size,
    color: textPrimary,
  );

  static TextStyle sans(double size, Color color) =>
      TextStyle(fontFamily: 'Inter', fontSize: size, color: color);

  static TextStyle mono(double size, Color color, {double? letterSpacing}) =>
      TextStyle(
        fontFamily: 'DMMono',
        fontSize: size,
        color: color,
        letterSpacing: letterSpacing,
      );
}
