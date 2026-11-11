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
        scaffoldBackgroundColor: Brand.black,
        textSelectionTheme: const TextSelectionThemeData(
          cursorColor: Brand.offWhite,
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
  final _focus = FocusNode();
  bool _showError = false;
  String? _greeted;

  @override
  void initState() {
    super.initState();
    _focus.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _name.dispose();
    _focus.dispose();
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

  /// Focus and the error change the outline's colour only, so nothing moves.
  Color get _outline {
    if (_showError) return Brand.mint;
    return _focus.hasFocus ? Brand.green : Colors.transparent;
  }

  @override
  Widget build(BuildContext context) {
    // Light status bar icons over the dark canvas.
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        body: SafeArea(
          // Scrolls when the keyboard leaves too little height for the form.
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Semantics(
                    label: 'e2e',
                    image: true,
                    child: const CustomPaint(
                      size: Size(69, 24),
                      painter: LogotypePainter(Brand.offWhite),
                    ),
                  ),
                ),
                Container(height: 1, color: Brand.neutral800),
                const SizedBox(height: 48),
                Text(
                  '[ with-flutter ]',
                  style: Brand.mono(12, Brand.green, letterSpacing: 0.48),
                ),
                const SizedBox(height: 8),
                Semantics(
                  header: true,
                  child: Text(
                    'say hello',
                    style: Brand.sans(
                      39,
                      Brand.offWhite,
                    ).copyWith(height: 44 / 39, letterSpacing: -1.17),
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  'A demo screen for the e2e examples. Type a name and the app greets you.',
                  style: Brand.sans(18, Brand.neutral500).copyWith(height: 1.4),
                ),
                const SizedBox(height: 40),
                // The design system's text field: the label sits inside the field, above the value.
                // identifier is what getByTestId finds: the resource id on Android,
                // the accessibility identifier on iOS.
                Semantics(
                  identifier: 'name',
                  label: 'name',
                  child: Container(
                    height: 56,
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    decoration: BoxDecoration(
                      color: Brand.neutral800,
                      border: Border.all(color: _outline, width: 2),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // The field carries the name for assistive tech.
                        ExcludeSemantics(
                          child: Text(
                            'name',
                            style: Brand.mono(12, Brand.neutral400),
                          ),
                        ),
                        const SizedBox(height: 4),
                        TextField(
                          controller: _name,
                          focusNode: _focus,
                          autocorrect: false,
                          textInputAction: TextInputAction.done,
                          onSubmitted: (_) => _greet(),
                          style: Brand.sans(16, Brand.offWhite),
                          decoration: const InputDecoration.collapsed(
                            hintText: '',
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                // MergeSemantics folds the identifier into the button's own node.
                // Buttons change no colour when pressed or hovered: no overlay, no splash.
                // Keyboard focus draws the green focus outline instead.
                MergeSemantics(
                  child: Semantics(
                    identifier: 'greet',
                    child: SizedBox(
                      width: double.infinity,
                      height: 48,
                      child: TextButton(
                        onPressed: _greet,
                        style:
                            TextButton.styleFrom(
                              backgroundColor: Brand.blue,
                              foregroundColor: Brand.offWhite,
                              overlayColor: Colors.transparent,
                              splashFactory: NoSplash.splashFactory,
                              shape: const RoundedRectangleBorder(),
                              textStyle: Brand.mono(15, Brand.offWhite),
                            ).copyWith(
                              side: WidgetStateProperty.resolveWith(
                                (states) => states.contains(WidgetState.focused)
                                    ? const BorderSide(
                                        color: Brand.green,
                                        width: 2,
                                      )
                                    : BorderSide.none,
                              ),
                            ),
                        child: const Text('greet'),
                      ),
                    ),
                  ),
                ),
                if (_showError) ...[
                  const SizedBox(height: 16),
                  Semantics(
                    identifier: 'error',
                    container: true,
                    // TalkBack and VoiceOver read the error when it appears.
                    liveRegion: true,
                    child: Text(
                      'enter a name first.',
                      style: Brand.sans(
                        14,
                        Brand.mint,
                      ).copyWith(height: 20 / 14),
                    ),
                  ),
                ],
                if (_greeted case final greeted?) ...[
                  const SizedBox(height: 16),
                  Semantics(
                    identifier: 'greeting',
                    container: true,
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(16),
                      color: Brand.neutral800,
                      child: Text(
                        'hello, $greeted!',
                        style: Brand.sans(
                          16,
                          Brand.offWhite,
                        ).copyWith(height: 22 / 16),
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

/// The e2e logotype, drawn from the official logo's bars so it stays sharp at any size.
class LogotypePainter extends CustomPainter {
  const LogotypePainter(this.color);

  final Color color;

  static const _bars = <List<double>>[
    [155.91, 0, 90.24, 19.06],
    [26.94, 24.48, 82.4, 19.09],
    [145.32, 24.48, 35.83, 19.09],
    [220.91, 24.48, 35.84, 19.09],
    [297.82, 24.48, 82.43, 19.09],
    [10.59, 49.04, 32.69, 19.05],
    [92.79, 49.04, 33.14, 19.05],
    [210.32, 49.04, 35.83, 19.05],
    [281.46, 49.04, 32.69, 19.05],
    [363.66, 49.04, 33.18, 19.05],
    [0, 73.54, 135.96, 19.08],
    [185.09, 73.54, 35.8, 19.08],
    [270.88, 73.54, 135.97, 19.08],
    [4.13, 98.07, 32.68, 19.05],
    [158.07, 98.04, 35.83, 19.08],
    [274.98, 98.07, 32.68, 19.05],
    [26.94, 122.57, 82.4, 19.05],
    [145.32, 122.57, 113.33, 19.05],
    [297.82, 122.57, 82.43, 19.05],
  ];

  @override
  void paint(Canvas canvas, Size size) {
    final scale = [
      size.width / 407,
      size.height / 142,
    ].reduce((a, b) => a < b ? a : b);
    final paint = Paint()..color = color;
    for (final [x, y, width, height] in _bars) {
      canvas.drawRect(
        Rect.fromLTWH(x * scale, y * scale, width * scale, height * scale),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(LogotypePainter oldDelegate) => oldDelegate.color != color;
}

/// e2e design system: black canvas, square corners, e2e blue for the one action, green and mint
/// accents, an 8px spacing grid, and lowercase headings and UI. Inter and JetBrains Mono stand in
/// for the brand's own typefaces.
abstract final class Brand {
  static const black = Color(0xFF000000);
  static const offWhite = Color(0xFFF7F7F7);
  static const neutral800 = Color(0xFF1C1C1C);
  static const neutral500 = Color(0xFF8D8D8D);
  static const neutral400 = Color(0xFFB1B1B1);
  static const blue = Color(0xFF1A5FFF);
  static const green = Color(0xFF64FF9D);
  static const mint = Color(0xFF8AF9FF);

  static TextStyle sans(double size, Color color) =>
      TextStyle(fontFamily: 'Inter', fontSize: size, color: color);

  static TextStyle mono(double size, Color color, {double? letterSpacing}) =>
      TextStyle(
        fontFamily: 'JetBrainsMono',
        fontSize: size,
        color: color,
        letterSpacing: letterSpacing,
      );
}
