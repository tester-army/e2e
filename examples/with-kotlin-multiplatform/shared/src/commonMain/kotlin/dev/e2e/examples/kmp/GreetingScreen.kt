package dev.e2e.examples.kmp

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.e2e.examples.kmp.resources.Res
import dev.e2e.examples.kmp.resources.inter_regular
import dev.e2e.examples.kmp.resources.jetbrains_mono_regular
import org.jetbrains.compose.resources.Font

/** The whole app: one screen shared by Android and iOS. */
@Composable
fun GreetingScreen() {
    val name = rememberTextFieldState()
    var focused by remember { mutableStateOf(false) }
    var showError by rememberSaveable { mutableStateOf(false) }
    var greeted by rememberSaveable { mutableStateOf<String?>(null) }
    val focusManager = LocalFocusManager.current

    fun greet() {
        focusManager.clearFocus()
        val value = name.text.trim().toString()
        if (value.isEmpty()) {
            showError = true
            greeted = null
            return
        }
        showError = false
        greeted = value
        name.clearText()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Brand.black)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            // Scrolls when the keyboard leaves too little height for the form.
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp),
    ) {
        Logotype(
            modifier = Modifier
                .padding(vertical = 12.dp)
                .size(width = 69.dp, height = 24.dp)
                .semantics { contentDescription = "e2e" },
        )

        Box(Modifier.fillMaxWidth().height(1.dp).background(Brand.neutral800))

        Column(modifier = Modifier.padding(top = 48.dp)) {
            BasicText("[ with-kotlin-multiplatform ]", style = Brand.mono(12, Brand.green, letterSpacing = 0.48.sp))
            BasicText(
                "say hello",
                style = Brand.sans(39, Brand.offWhite).copy(lineHeight = 44.sp, letterSpacing = (-1.17).sp),
                modifier = Modifier.padding(top = 8.dp).semantics { heading() },
            )
            BasicText(
                "A demo screen for the e2e examples. Type a name and the app greets you.",
                style = Brand.sans(18, Brand.neutral500).copy(lineHeight = 25.sp),
                modifier = Modifier.padding(top = 24.dp),
            )

            Column(
                modifier = Modifier.padding(top = 40.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // The design system's text field: the label sits inside the field, above the value.
                // Focus and the error change the outline's colour only, so nothing moves.
                val outline = when {
                    showError -> Brand.mint
                    focused -> Brand.green
                    else -> Color.Transparent
                }
                BasicTextField(
                    state = name,
                    modifier = Modifier
                        // testTag is what getByTestId finds: the accessibility identifier on iOS, the
                        // resource id on Android (MainActivity turns on testTagsAsResourceId).
                        .testTag("name")
                        .semantics { contentDescription = "name" }
                        .onFocusChanged { focused = it.isFocused }
                        .fillMaxWidth()
                        .height(56.dp)
                        .background(Brand.neutral800)
                        .border(2.dp, outline),
                    textStyle = Brand.sans(16, Brand.offWhite),
                    cursorBrush = SolidColor(Brand.offWhite),
                    lineLimits = TextFieldLineLimits.SingleLine,
                    onKeyboardAction = { greet() },
                    decorator = { field ->
                        Column(
                            modifier = Modifier.padding(horizontal = 16.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
                        ) {
                            // The field carries the name for TalkBack.
                            BasicText(
                                "name",
                                style = Brand.mono(12, Brand.neutral400),
                                modifier = Modifier.semantics { hideFromAccessibility() },
                            )
                            field()
                        }
                    },
                )

                // Controls are at least 48dp tall, Android's minimum touch target. Below that, Compose
                // reports the control at 48dp but its role node at the drawn size, and
                // agent-device reads that role node as a second button it will not tap through.
                val press = remember { MutableInteractionSource() }
                val pressed by press.collectIsPressedAsState()
                Box(
                    modifier = Modifier
                        .testTag("greet")
                        // Buttons change no colour when pressed; a press scales them a little.
                        .scale(if (pressed) 0.98f else 1f)
                        .fillMaxWidth()
                        .height(48.dp)
                        .background(Brand.blue)
                        .clickable(interactionSource = press, indication = null, role = Role.Button, onClick = ::greet),
                    contentAlignment = Alignment.Center,
                ) {
                    BasicText("greet", style = Brand.mono(15, Brand.offWhite))
                }

                if (showError) {
                    BasicText(
                        "enter a name first.",
                        style = Brand.sans(14, Brand.mint).copy(lineHeight = 20.sp),
                        modifier = Modifier
                            .testTag("error")
                            // TalkBack reads the error when it appears.
                            .semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }

                greeted?.let {
                    BasicText(
                        "hello, $it!",
                        style = Brand.sans(16, Brand.offWhite).copy(lineHeight = 22.sp),
                        modifier = Modifier
                            .testTag("greeting")
                            .fillMaxWidth()
                            .background(Brand.neutral800)
                            .padding(16.dp),
                    )
                }
            }
        }
    }
}

/** The e2e logotype, drawn from the official logo's bars so it stays sharp at any size. */
@Composable
private fun Logotype(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val scale = minOf(size.width / 407f, size.height / 142f)
        for ((x, y, width, height) in LOGOTYPE_BARS) {
            drawRect(Brand.offWhite, Offset(x * scale, y * scale), Size(width * scale, height * scale))
        }
    }
}

private val LOGOTYPE_BARS = listOf(
    listOf(155.91f, 0f, 90.24f, 19.06f),
    listOf(26.94f, 24.48f, 82.4f, 19.09f),
    listOf(145.32f, 24.48f, 35.83f, 19.09f),
    listOf(220.91f, 24.48f, 35.84f, 19.09f),
    listOf(297.82f, 24.48f, 82.43f, 19.09f),
    listOf(10.59f, 49.04f, 32.69f, 19.05f),
    listOf(92.79f, 49.04f, 33.14f, 19.05f),
    listOf(210.32f, 49.04f, 35.83f, 19.05f),
    listOf(281.46f, 49.04f, 32.69f, 19.05f),
    listOf(363.66f, 49.04f, 33.18f, 19.05f),
    listOf(0f, 73.54f, 135.96f, 19.08f),
    listOf(185.09f, 73.54f, 35.8f, 19.08f),
    listOf(270.88f, 73.54f, 135.97f, 19.08f),
    listOf(4.13f, 98.07f, 32.68f, 19.05f),
    listOf(158.07f, 98.04f, 35.83f, 19.08f),
    listOf(274.98f, 98.07f, 32.68f, 19.05f),
    listOf(26.94f, 122.57f, 82.4f, 19.05f),
    listOf(145.32f, 122.57f, 113.33f, 19.05f),
    listOf(297.82f, 122.57f, 82.43f, 19.05f),
)

/**
 * e2e design system: black canvas, square corners, e2e blue for the one action, green and mint
 * accents, an 8dp spacing grid, and lowercase headings and UI. Inter and JetBrains Mono stand in
 * for the brand's own typefaces.
 */
private object Brand {
    val black = Color(0xFF000000)
    val offWhite = Color(0xFFF7F7F7)
    val neutral800 = Color(0xFF1C1C1C)
    val neutral500 = Color(0xFF8D8D8D)
    val neutral400 = Color(0xFFB1B1B1)
    val blue = Color(0xFF1A5FFF)
    val green = Color(0xFF64FF9D)
    val mint = Color(0xFF8AF9FF)

    // Compose resources load fonts in composition, so the styles are read there.
    @Composable
    fun sans(size: Int, color: Color) = TextStyle(
        color = color,
        fontFamily = FontFamily(Font(Res.font.inter_regular)),
        fontSize = size.sp,
    )

    @Composable
    fun mono(size: Int, color: Color, letterSpacing: TextUnit = TextUnit.Unspecified) = TextStyle(
        color = color,
        fontFamily = FontFamily(Font(Res.font.jetbrains_mono_regular)),
        fontSize = size.sp,
        letterSpacing = letterSpacing,
    )
}
