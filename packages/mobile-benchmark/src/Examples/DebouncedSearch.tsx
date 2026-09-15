import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const DEBOUNCE_MS = 400;
const FETCH_MS = 800;
const TARGET = "Benchmark Target";

const DATASET = [
  "Alpha Report",
  "Benchmark Target",
  "Benchmark Baseline",
  "Beta Rollout",
  "Bench Press Guide",
  "Charlie Checklist",
  "Delta Dashboard",
  "Echo Environment",
];

/**
 * Filters the deterministic dataset with a case-insensitive substring match,
 * mimicking a backend search endpoint.
 */
function searchDataset(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  return DATASET.filter((item) => item.toLowerCase().includes(normalized));
}

export default function DebouncedSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (!query.trim()) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      fetchTimerRef.current = setTimeout(() => {
        setResults(searchDataset(query));
        setSearching(false);
      }, FETCH_MS);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(debounceTimer);
      if (fetchTimerRef.current) {
        clearTimeout(fetchTimerRef.current);
      }
    };
  }, [query]);

  if (selected === TARGET) {
    return (
      <View style={styles.center}>
        <Text testID="success-message" style={styles.successText}>
          Selected {TARGET}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>Search for and select {`"${TARGET}"`}</Text>
      <TextInput
        testID="search-input"
        style={styles.input}
        placeholder="Search…"
        autoCapitalize="none"
        autoCorrect={false}
        value={query}
        onChangeText={setQuery}
      />
      {searching ? (
        <ActivityIndicator testID="search-loading" style={styles.loader} />
      ) : (
        <FlatList
          testID="search-results"
          data={results}
          keyExtractor={(item) => item}
          ListEmptyComponent={
            query.trim() ? <Text style={styles.emptyText}>No results</Text> : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`result-${item}`}
              style={styles.row}
              onPress={() => setSelected(item)}
            >
              <Text style={styles.rowText}>{item}</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  hint: {
    fontSize: 13,
    color: "#666",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  loader: {
    marginTop: 24,
  },
  emptyText: {
    marginTop: 24,
    textAlign: "center",
    color: "#666",
  },
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d0d0d0",
  },
  rowText: {
    fontSize: 16,
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
