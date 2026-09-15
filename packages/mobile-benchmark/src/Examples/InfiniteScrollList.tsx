import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const PAGE_SIZE = 30;
const TOTAL_ITEMS = 150;
const TARGET_ITEM = 137;

/**
 * Builds one page of deterministic list items so every run of the benchmark
 * produces identical content.
 */
function buildPage(page: number): number[] {
  const start = page * PAGE_SIZE;
  return Array.from({ length: Math.min(PAGE_SIZE, TOTAL_ITEMS - start) }, (_, i) => start + i + 1);
}

export default function InfiniteScrollList() {
  const [items, setItems] = useState<number[]>(() => buildPage(0));
  const [loading, setLoading] = useState(false);
  const [foundTarget, setFoundTarget] = useState(false);

  const loadMore = useCallback(() => {
    if (loading || items.length >= TOTAL_ITEMS) {
      return;
    }
    setLoading(true);
    setTimeout(() => {
      setItems((current) => [...current, ...buildPage(current.length / PAGE_SIZE)]);
      setLoading(false);
    }, 600);
  }, [loading, items.length]);

  if (foundTarget) {
    return (
      <View style={styles.successContainer}>
        <Text testID="success-message" style={styles.successText}>
          Found item {TARGET_ITEM}
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      testID="benchmark-list"
      data={items}
      keyExtractor={(item) => String(item)}
      ListHeaderComponent={
        <Text style={styles.hint}>Scroll down and tap Item {TARGET_ITEM} to complete</Text>
      }
      ListFooterComponent={
        loading ? <ActivityIndicator testID="list-loading" style={styles.loader} /> : null
      }
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      renderItem={({ item }) => (
        <TouchableOpacity
          testID={`item-${item}`}
          style={styles.row}
          onPress={() => {
            if (item === TARGET_ITEM) {
              setFoundTarget(true);
            }
          }}
        >
          <Text style={styles.rowText}>Item {item}</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  hint: {
    padding: 16,
    fontSize: 13,
    color: "#666",
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d0d0d0",
  },
  rowText: {
    fontSize: 16,
  },
  loader: {
    paddingVertical: 16,
  },
  successContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
