import { NavigationContainer, useNavigation } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { examples } from "./examples";

const visibleExamples = examples.filter((example) =>
  example.platform ? example.platform === Platform.OS : true,
);

/**
 * The home list, two columns of compact rows so every scenario is on screen
 * on a phone: a suite reaches a scenario with one tap and no scrolling, and
 * a row is never straddling the edge where a tap lands on its neighbour.
 */
function ExampleList() {
  const navigation = useNavigation();
  return (
    <ScrollView testID="e2e-screen:Benchmark Examples" contentInsetAdjustmentBehavior="automatic">
      <View style={styles.exampleGrid}>
        {visibleExamples.map((example) => (
          <TouchableOpacity
            key={example.name}
            testID={example.name}
            accessibilityLabel={`${example.name}. ${example.description}`}
            style={styles.exampleTouchable}
            onPress={() => {
              // @ts-expect-error dynamic route names from the examples registry
              navigation.navigate(example.name);
            }}
          >
            <Text style={styles.exampleName} numberOfLines={2}>
              {example.name}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

/**
 * Two marked layers stay mounted and visible in the same accessibility tree.
 */
function LayeredMarkers() {
  return (
    <View style={styles.layers}>
      <View testID="e2e-screen:Underlay" style={styles.underlay}>
        <Text>Underlay</Text>
      </View>
      <View testID="e2e-screen:Cover" style={styles.cover}>
        <Text>Cover</Text>
      </View>
    </View>
  );
}

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer
        linking={{
          prefixes: ["e2e-benchmark://"],
          config: { screens: { "Layered Markers": "layers" } },
          filter: url => url === "e2e-benchmark:///layers",
        }}
      >
        <Stack.Navigator initialRouteName="Benchmark Examples">
          <Stack.Screen name="Benchmark Examples" component={ExampleList} />
          <Stack.Screen
            name="Layered Markers"
            component={LayeredMarkers}
            options={{ headerShown: false }}
          />
          {visibleExamples.map((example) => (
            <Stack.Screen
              key={example.name}
              name={example.name}
              component={example.component}
              options={example.screenOptions}
            />
          ))}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  exampleGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  exampleTouchable: {
    width: "50%",
    height: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d0d0d0",
  },
  exampleName: {
    fontSize: 13,
    fontWeight: "600",
  },
  layers: {
    flex: 1,
  },
  underlay: {
    flex: 1,
    padding: 24,
  },
  cover: {
    position: "absolute",
    bottom: 24,
    left: 24,
    right: 24,
    padding: 24,
    backgroundColor: "#ffffff",
  },
});
