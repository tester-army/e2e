import { NavigationContainer, useNavigation } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { examples } from "./examples";

const visibleExamples = examples.filter((example) =>
  example.platform ? example.platform === Platform.OS : true,
);

function ExampleList() {
  const navigation = useNavigation();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      {visibleExamples.map((example) => (
        <TouchableOpacity
          key={example.name}
          testID={example.name}
          style={styles.exampleTouchable}
          onPress={() => {
            // @ts-expect-error dynamic route names from the examples registry
            navigation.navigate(example.name);
          }}
        >
          <Text style={styles.exampleName}>{example.name}</Text>
          <Text style={styles.exampleDescription}>{example.description}</Text>
        </TouchableOpacity>
      ))}
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
  exampleTouchable: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d0d0d0",
  },
  exampleName: {
    fontSize: 16,
    fontWeight: "600",
  },
  exampleDescription: {
    marginTop: 2,
    fontSize: 13,
    color: "#666",
  },
});
