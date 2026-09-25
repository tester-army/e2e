import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Product = {
  id: string;
  name: string;
  size: string;
  price: string;
};

const TARGET_ID = "trail-mix-500";
const TARGET_QUANTITY = 2;

const PRODUCTS: Product[] = [
  { id: "trail-mix-250", name: "Trail Mix", size: "250 g", price: "$3.99" },
  { id: "trail-mix-500", name: "Trail Mix", size: "500 g", price: "$6.99" },
  { id: "trail-mix-1000", name: "Trail Mix", size: "1 kg", price: "$11.99" },
  { id: "granola-500", name: "Granola", size: "500 g", price: "$5.49" },
  { id: "almonds-250", name: "Almonds", size: "250 g", price: "$7.99" },
  { id: "cashews-250", name: "Cashews", size: "250 g", price: "$8.49" },
];

/**
 * Master-detail drill-in with near-identical repeated cards. The agent must
 * disambiguate the "Trail Mix 500 g" card from its sibling variants, open its
 * detail view, set the quantity to 2 with the stepper, add it to the cart, and
 * confirm the cart contents. Favorite hearts are interactive decoys.
 */
export default function ProductCatalog() {
  const [view, setView] = useState<"list" | "detail" | "cart">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});

  const cartCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  const succeeded = cart[TARGET_ID] === TARGET_QUANTITY && Object.keys(cart).length === 1;
  const selected = PRODUCTS.find((product) => product.id === selectedId);

  /**
   * Toggles the favorite heart for a product; a decoy interaction that never
   * contributes to the success state.
   */
  const toggleFavorite = (id: string) => {
    setFavorites((current) => ({ ...current, [id]: !current[id] }));
  };

  /**
   * Adds the currently selected product and quantity to the cart, then
   * returns to the list view.
   */
  const handleAddToCart = () => {
    if (!selected) return;
    setCart((current) => ({
      ...current,
      [selected.id]: (current[selected.id] ?? 0) + quantity,
    }));
    setView("list");
  };

  if (view === "detail" && selected) {
    return (
      <View style={styles.container}>
        <TouchableOpacity testID="back-to-list" onPress={() => setView("list")}>
          <Text style={styles.link}>‹ Back to catalog</Text>
        </TouchableOpacity>
        <Text style={styles.detailTitle}>
          {selected.name} {selected.size}
        </Text>
        <Text style={styles.detailPrice}>{selected.price}</Text>
        <View style={styles.stepperRow}>
          <TouchableOpacity
            testID="quantity-decrease"
            style={styles.stepperButton}
            onPress={() => setQuantity((current) => Math.max(1, current - 1))}
          >
            <Text style={styles.stepperButtonText}>−</Text>
          </TouchableOpacity>
          <Text testID="quantity-value" style={styles.quantity}>
            {quantity}
          </Text>
          <TouchableOpacity
            testID="quantity-increase"
            style={styles.stepperButton}
            onPress={() => setQuantity((current) => current + 1)}
          >
            <Text style={styles.stepperButtonText}>+</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity testID="add-to-cart" style={styles.button} onPress={handleAddToCart}>
          <Text style={styles.buttonText}>Add to cart</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (view === "cart") {
    return (
      <View style={styles.container}>
        <TouchableOpacity testID="back-to-list" onPress={() => setView("list")}>
          <Text style={styles.link}>‹ Back to catalog</Text>
        </TouchableOpacity>
        <Text style={styles.detailTitle}>Cart</Text>
        {cartCount === 0 && <Text style={styles.hint}>The cart is empty</Text>}
        {PRODUCTS.filter((product) => cart[product.id]).map((product) => (
          <Text key={product.id} style={styles.cartLine}>
            {cart[product.id]} × {product.name} {product.size}
          </Text>
        ))}
        {succeeded && (
          <Text testID="success-message" style={styles.successText}>
            Order ready: 2 × Trail Mix 500 g
          </Text>
        )}
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Text style={styles.hint}>
        Add exactly {TARGET_QUANTITY} × Trail Mix 500 g to the cart, then review the cart
      </Text>
      <TouchableOpacity
        testID="open-cart"
        style={styles.cartButton}
        onPress={() => setView("cart")}
      >
        <Text style={styles.cartButtonText}>Cart ({cartCount})</Text>
      </TouchableOpacity>
      {PRODUCTS.map((product) => (
        <View key={product.id} style={styles.card}>
          <TouchableOpacity
            testID={`product-${product.id}`}
            style={styles.cardBody}
            onPress={() => {
              setSelectedId(product.id);
              setQuantity(1);
              setView("detail");
            }}
          >
            <Text style={styles.cardName}>{product.name}</Text>
            <Text style={styles.cardMeta}>
              {product.size} · {product.price}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`favorite-${product.id}`}
            accessibilityLabel={`Favorite ${product.name} ${product.size}`}
            onPress={() => toggleFavorite(product.id)}
          >
            <Text style={styles.favorite}>{favorites[product.id] ? "♥" : "♡"}</Text>
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    gap: 12,
  },
  list: {
    padding: 16,
    gap: 8,
  },
  hint: {
    fontSize: 14,
    color: "#666",
  },
  link: {
    fontSize: 16,
    color: "#0066cc",
  },
  cartButton: {
    alignSelf: "flex-end",
    backgroundColor: "#eee",
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  cartButtonText: {
    fontSize: 14,
    fontWeight: "600",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d0d0d0",
    borderRadius: 8,
    padding: 12,
  },
  cardBody: {
    flex: 1,
  },
  cardName: {
    fontSize: 16,
    fontWeight: "600",
  },
  cardMeta: {
    fontSize: 13,
    color: "#666",
    marginTop: 2,
  },
  favorite: {
    fontSize: 22,
    color: "#c00",
    paddingHorizontal: 8,
  },
  detailTitle: {
    fontSize: 22,
    fontWeight: "600",
  },
  detailPrice: {
    fontSize: 17,
    color: "#333",
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#eee",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperButtonText: {
    fontSize: 22,
    fontWeight: "600",
  },
  quantity: {
    fontSize: 20,
    fontWeight: "600",
    minWidth: 24,
    textAlign: "center",
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  cartLine: {
    fontSize: 16,
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
    marginTop: 12,
  },
});
