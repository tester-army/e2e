"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

const CLOSE_DELAY_MS = 200;

const MENUS: Record<string, string[]> = {
  Products: ["Profile", "Invoices"],
  Settings: ["Profile", "Sign out"],
  Account: ["Billing", "Profile", "Sign out"],
};

const FLYOUT_ITEMS = ["Redeem voucher", "Invoices"];

/**
 * Sabotage scenario: a hover-intent gated menu with no click-to-open path.
 * Submenus open on onMouseEnter only and close CLOSE_DELAY_MS after
 * onMouseLeave, with the close timer canceled on re-enter - so the agent must
 * keep the pointer inside the menu chain while traversing Account → Billing →
 * Redeem voucher. Clicking the top-level items does nothing, and decoy leaves
 * punish guessing.
 */
export default function HoverMenu() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const closeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyoutCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeRef.current) clearTimeout(closeRef.current);
      if (flyoutCloseRef.current) clearTimeout(flyoutCloseRef.current);
    };
  }, []);

  const enterMenu = (menu: string) => {
    if (closeRef.current) clearTimeout(closeRef.current);
    if (openMenu !== menu) {
      setFlyoutOpen(false);
    }
    setOpenMenu(menu);
  };

  /**
   * Schedules the submenu (and its flyout) to close after the hover-intent
   * delay; re-entering any part of the menu chain cancels it.
   */
  const leaveMenu = () => {
    if (closeRef.current) clearTimeout(closeRef.current);
    closeRef.current = setTimeout(() => {
      setOpenMenu(null);
      setFlyoutOpen(false);
    }, CLOSE_DELAY_MS);
  };

  const enterFlyoutTrigger = () => {
    if (flyoutCloseRef.current) clearTimeout(flyoutCloseRef.current);
    setFlyoutOpen(true);
  };

  const leaveFlyout = () => {
    if (flyoutCloseRef.current) clearTimeout(flyoutCloseRef.current);
    flyoutCloseRef.current = setTimeout(() => setFlyoutOpen(false), CLOSE_DELAY_MS);
  };

  const handleLeafClick = (label: string) => {
    if (label === "Redeem voucher") {
      setError(null);
      setDone(true);
      return;
    }
    setError("That is not the action");
  };

  if (done) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Voucher redeemed
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>Using hover only, find Redeem voucher under Account.</p>
      <div style={styles.navRow}>
        {Object.keys(MENUS).map((menu) => (
          <div
            key={menu}
            style={styles.navItemWrap}
            onMouseEnter={() => enterMenu(menu)}
            onMouseLeave={leaveMenu}
          >
            <span data-testid={`menu-${menu.toLowerCase()}`} style={styles.navItem}>
              {menu}
            </span>
            {openMenu === menu ? (
              <div style={styles.submenu}>
                {MENUS[menu]?.map((item) =>
                  menu === "Account" && item === "Billing" ? (
                    <div
                      key={item}
                      style={styles.submenuItemWrap}
                      onMouseEnter={enterFlyoutTrigger}
                      onMouseLeave={leaveFlyout}
                    >
                      <span style={styles.submenuItem}>{item} ›</span>
                      {flyoutOpen ? (
                        <div style={styles.flyout}>
                          {FLYOUT_ITEMS.map((leaf) => (
                            <span
                              key={leaf}
                              style={styles.submenuItem}
                              onClick={() => handleLeafClick(leaf)}
                            >
                              {leaf}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <span
                      key={item}
                      style={styles.submenuItem}
                      onClick={() => handleLeafClick(item)}
                    >
                      {item}
                    </span>
                  ),
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "24px 0",
  },
  hint: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
    margin: 0,
  },
  navRow: {
    display: "flex",
    gap: 24,
    justifyContent: "center",
    borderBottom: "1px solid #e5e5e5",
    paddingBottom: 8,
  },
  navItemWrap: {
    position: "relative",
  },
  navItem: {
    fontSize: 16,
    fontWeight: 600,
    color: "#111",
    cursor: "default",
    padding: "6px 4px",
  },
  submenu: {
    position: "absolute",
    top: "100%",
    left: 0,
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    minWidth: 160,
    backgroundColor: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
    padding: 4,
  },
  submenuItemWrap: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
  },
  submenuItem: {
    fontSize: 15,
    color: "#333",
    padding: "8px 10px",
    borderRadius: 6,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  flyout: {
    position: "absolute",
    top: 0,
    left: "100%",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    minWidth: 160,
    backgroundColor: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
    padding: 4,
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    margin: 0,
    textAlign: "center",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
