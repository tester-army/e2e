import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

function HomeTab() {
  return (
    <View style={styles.container}>
      <Text testID="home-tab-content" style={styles.title}>
        Home
      </Text>
      <Text style={styles.hint}>Go to the Actions tab and press the button there.</Text>
    </View>
  );
}

function FeedTab() {
  return (
    <View style={styles.container}>
      <Text testID="feed-tab-content" style={styles.title}>
        Feed
      </Text>
    </View>
  );
}

function ActionsTab() {
  const [done, setDone] = useState(false);
  return (
    <View style={styles.container}>
      {done ? (
        <Text testID="success-message" style={styles.successText}>
          Action completed
        </Text>
      ) : (
        <TouchableOpacity
          testID="complete-action-button"
          style={styles.button}
          onPress={() => setDone(true)}
        >
          <Text style={styles.buttonText}>Complete action</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const Tab = createBottomTabNavigator();

export default function BottomTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeTab} options={{ tabBarButtonTestID: "tab-home" }} />
      <Tab.Screen
        name="Feed"
        component={FeedTab}
        options={{ tabBarBadge: 3, tabBarButtonTestID: "tab-feed" }}
      />
      <Tab.Screen
        name="Actions"
        component={ActionsTab}
        options={{ tabBarButtonTestID: "tab-actions" }}
      />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
  },
  hint: {
    fontSize: 13,
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
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
