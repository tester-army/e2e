package dev.e2e.examples.kmp

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Light status bar icons over the dark canvas.
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        setContent {
            // Exposes each testTag as the Android resource id, which getByTestId finds.
            // The setting is Android-only, so it lives here rather than in shared code.
            Box(Modifier.semantics { testTagsAsResourceId = true }) {
                GreetingScreen()
            }
        }
    }
}
