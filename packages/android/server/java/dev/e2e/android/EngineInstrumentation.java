package dev.e2e.android;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * The e2e engine server for Android, running on the device as an
 * instrumentation. It speaks the e2e engine protocol (JSON-RPC 2.0 framed
 * by Content-Length headers, as LSP) on an abstract local socket the host
 * reaches through `adb forward`, and drives the device in process through
 * UiAutomation: no adb round trip, no shell process, and no XML dump per
 * call.
 */
public final class EngineInstrumentation extends Instrumentation {
  static final String TAG = "e2e-android";

  private String socketName = "e2e-android-engine";

  @Override
  public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    if (arguments != null && arguments.getString("socket") != null) socketName = arguments.getString("socket");
    start();
  }

  @Override
  public void onStart() {
    try {
      UiAutomation automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
      AccessibilityServiceInfo info = automation.getServiceInfo();
      info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
          | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
          | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
      automation.setServiceInfo(info);
      JSONObject manifest = new JSONObject(readAsset("manifest.json"));
      Device device = new Device(getContext(), automation);
      LocalServerSocket server = new LocalServerSocket(socketName);
      Bundle ready = new Bundle();
      ready.putString("ready", "true");
      sendStatus(1, ready);
      // One connection at a time: the device has one screen, so a second
      // client waits until the first one is gone.
      while (true) {
        LocalSocket socket = server.accept();
        new Session(this, device, manifest, socket).run();
      }
    } catch (Throwable failure) {
      Log.e(TAG, "engine server failed", failure);
      Bundle result = new Bundle();
      result.putString("error", String.valueOf(failure));
      finish(1, result);
    }
  }

  /** Ends the instrumentation once the client sent `exit`. */
  void exit() {
    finish(0, new Bundle());
  }

  private String readAsset(String name) throws java.io.IOException {
    try (InputStream input = getContext().getAssets().open(name)) {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int read;
      while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
      return output.toString(StandardCharsets.UTF_8.name());
    }
  }
}
