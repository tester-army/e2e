import { useState } from "react";
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";

const TOTAL_ROWS = 600;
const TARGET_ROW = 512;
const ROW_HEIGHT = 56;

const rows = Array.from({ length: TOTAL_ROWS }, (_, i) => i + 1);

/**
 * Formats a row number with leading zeros so labels sort and read
 * consistently ("Row 0007", "Row 0512").
 */
function rowLabel(row: number): string {
  return `Row ${String(row).padStart(4, "0")}`;
}

/**
 * A very long virtualized list with no pagination: all 600 rows exist up
 * front, but FlatList only materializes rows near the viewport, so off-screen
 * rows never appear in the accessibility tree. The only signals of how much
 * content exists are the scroll indicator and the row numbering — the agent
 * must size a long jump toward the target (~28,000 px down) instead of
 * paging one screenful at a time.
 */
export default function HugeVirtualizedList() {
  const [found, setFound] = useState(false);

  if (found) {
    return (
      <View style={styles.successContainer}>
        <Text testID="success-message" style={styles.successText}>
          Found {rowLabel(TARGET_ROW)}
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      testID="huge-list"
      data={rows}
      keyExtractor={(item) => String(item)}
      getItemLayout={(_, index) => ({
        length: ROW_HEIGHT,
        offset: ROW_HEIGHT * index,
        index,
      })}
      ListHeaderComponent={
        <Text style={styles.hint}>
          All {TOTAL_ROWS} rows are loaded. Scroll to {rowLabel(TARGET_ROW)} and tap it.
        </Text>
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          testID={`row-${item}`}
          style={styles.row}
          onPress={() => {
            if (item === TARGET_ROW) {
              setFound(true);
            }
          }}
        >
          <Text style={styles.rowText}>{rowLabel(item)}</Text>
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
    height: ROW_HEIGHT,
    paddingHorizontal: 16,
    justifyContent: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d0d0d0",
  },
  rowText: {
    fontSize: 16,
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
