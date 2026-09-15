import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";

type AttachedPhoto = { uri: string; fileName: string };

/**
 * Gates the files-on-mobile delivery path: the harness seeds the attached
 * photos into the device photo library before the run, and the agent must
 * open the system photo picker (out of process - it never appears in the
 * app's own a11y tree), select the seeded photo, and land back in the app
 * with it attached.
 */
export default function PhotoPicker() {
  const [photo, setPhoto] = useState<AttachedPhoto | null>(null);
  const [picking, setPicking] = useState(false);

  /** Opens the system photo picker and records the selected photo. */
  const handlePick = async () => {
    setPicking(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      const asset = result.assets?.[0];
      if (!result.canceled && asset) {
        setPhoto({ uri: asset.uri, fileName: asset.fileName ?? "photo" });
      }
    } finally {
      setPicking(false);
    }
  };

  if (photo) {
    return (
      <View style={styles.center}>
        <Image source={{ uri: photo.uri }} style={styles.preview} resizeMode="contain" />
        <Text testID="success-message" style={styles.successText}>
          Receipt attached: {photo.fileName}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Expense report</Text>
      <Text style={styles.hint}>
        Attach the receipt photo from your photo library to submit this expense.
      </Text>
      <TouchableOpacity
        testID="choose-photo"
        style={styles.button}
        disabled={picking}
        onPress={handlePick}
      >
        <Text style={styles.buttonText}>{picking ? "Opening…" : "Choose photo"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
  },
  hint: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  preview: {
    width: 220,
    height: 220,
    borderRadius: 8,
    backgroundColor: "#f2f2f2",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
