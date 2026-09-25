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
    <ScrollView contentInsetAdjustmentBehavior="automatic">
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

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Benchmark Examples">
          <Stack.Screen name="Benchmark Examples" component={ExampleList} />
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
});
