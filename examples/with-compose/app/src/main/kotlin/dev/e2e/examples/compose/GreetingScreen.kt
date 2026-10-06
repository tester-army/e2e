package dev.e2e.examples.compose

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun GreetingScreen() {
    val name = rememberTextFieldState()
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
            .background(Brand.canvas)
            // testTag is what getByTestId finds once it is exposed as the Android resource id.
            .semantics { testTagsAsResourceId = true }
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 24.dp),
    ) {
        Row(
            modifier = Modifier.padding(vertical = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(
                painter = painterResource(R.drawable.helmet_mark),
                contentDescription = null,
                modifier = Modifier.size(32.dp),
            )
            BasicText("/", style = Brand.mono(26, Brand.textPrimary))
            BasicText("e2e", style = Brand.display(26).copy(letterSpacing = (-1.5).sp))
        }

        Box(Modifier.fillMaxWidth().height(0.5.dp).background(Brand.hairline))

        Column(
            modifier = Modifier.padding(top = 48.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            BasicText(
                "[01] with-compose".uppercase(),
                style = Brand.mono(12, Brand.textSecondary, letterSpacing = 0.6.sp),
            )
            BasicText(
                "Say hello",
                style = Brand.display(38).copy(lineHeight = 43.sp),
                modifier = Modifier.semantics { heading() },
            )
            BasicText(
                "A demo screen for the e2e examples. Type a name and the app greets you.",
                style = Brand.sans(16, Brand.textSecondary).copy(lineHeight = 24.sp),
            )

            Column(
                modifier = Modifier.padding(top = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                BasicText("NAME", style = Brand.mono(11, Brand.textFaint, letterSpacing = 1.1.sp))

                // Controls are 48dp tall, Android's minimum touch target. Below that, Compose
                // reports the control at 48dp but its role node at the drawn size, and
                // agent-device reads that role node as a second button it will not tap through.
                BasicTextField(
                    state = name,
                    modifier = Modifier
                        .testTag("name")
                        // The placeholder is not a name; without this the field reads as an unnamed textbox.
                        .semantics { contentDescription = "Name" }
                        .fillMaxWidth()
                        .height(48.dp)
                        .background(Brand.fieldFill)
                        .border(0.5.dp, Brand.fieldStroke),
                    textStyle = Brand.mono(14, Brand.textPrimary),
                    cursorBrush = SolidColor(Brand.textPrimary),
                    lineLimits = TextFieldLineLimits.SingleLine,
                    onKeyboardAction = { greet() },
                    decorator = { field ->
                        Box(Modifier.padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                            if (name.text.isEmpty()) {
                                BasicText("Ada Lovelace", style = Brand.mono(14, Brand.textFaint))
                            }
                            field()
                        }
                    },
                )

                Box(
                    modifier = Modifier
                        .testTag("greet")
                        .fillMaxWidth()
                        .height(48.dp)
                        .background(Brand.buttonFill)
                        .clickable(role = Role.Button, onClick = ::greet),
                    contentAlignment = Alignment.Center,
                ) {
                    BasicText("GREET", style = Brand.mono(13, Brand.textOnLight))
                }

                if (showError) {
                    BasicText(
                        "Enter a name first.",
                        style = Brand.sans(14, Brand.accent),
                        modifier = Modifier
                            .testTag("error")
                            // TalkBack reads the error when it appears.
                            .semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }

                greeted?.let {
                    BasicText(
                        "Hello, $it!",
                        style = Brand.sans(14, Brand.textPrimary).copy(lineHeight = 20.sp),
                        modifier = Modifier
                            .testTag("greeting")
                            .fillMaxWidth()
                            .background(Brand.panel)
                            .border(0.5.dp, Brand.hairline)
                            .padding(14.dp),
                    )
                }
            }
        }
    }
}

/** e2e brand: dark canvas, square corners, hairlines instead of shadows, white text at falling alphas. */
private object Brand {
    val canvas = Color(0xFF111111)
    val panel = Color(0xFF161616)
    val fieldFill = Color(0xFF1A1A1A)
    val buttonFill = Color(0xFFF9F8F7)
    val textPrimary = Color(0xFFF9F8F7)
    val textOnLight = Color(0xFF161616)
    val textSecondary = Color.White.copy(alpha = 0.7f)
    val textFaint = Color.White.copy(alpha = 0.5f)
    val hairline = Color.White.copy(alpha = 0.12f)
    val fieldStroke = Color.White.copy(alpha = 0.3f)
    val accent = Color(0xFFFF8001)

    private val displayFamily = FontFamily(Font(R.font.stack_sans_notch_regular))
    private val sansFamily = FontFamily(Font(R.font.inter_regular))
    private val monoFamily = FontFamily(Font(R.font.dm_mono_regular))

    fun display(size: Int) = TextStyle(color = textPrimary, fontFamily = displayFamily, fontSize = size.sp)

    fun sans(size: Int, color: Color) = TextStyle(color = color, fontFamily = sansFamily, fontSize = size.sp)

    fun mono(size: Int, color: Color, letterSpacing: TextUnit = TextUnit.Unspecified) =
        TextStyle(color = color, fontFamily = monoFamily, fontSize = size.sp, letterSpacing = letterSpacing)
}

@Preview(widthDp = 390, heightDp = 844)
@Composable
private fun GreetingScreenPreview() {
    GreetingScreen()
}
