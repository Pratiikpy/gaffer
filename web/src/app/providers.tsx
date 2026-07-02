"use client";
import { PrivyProvider } from "@privy-io/react-auth";
import { WalletProvider } from "@/lib/walletCtx";

/**
 * Production wallet = Privy (embedded, no seed phrase, social/email login + fiat on-ramp) — active
 * whenever NEXT_PUBLIC_PRIVY_APP_ID is set. Without it, a local dev embedded wallet is used so the
 * full loop is runnable. Either way, children see a wallet via `useAppWallet()`.
 */
const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export function Providers({ children }: { children: React.ReactNode }) {
  if (!APP_ID) return <WalletProvider>{children}</WalletProvider>;
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        appearance: { theme: "light", accentColor: "#059669" },
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
        loginMethods: ["email", "google", "telegram"],
      }}
    >
      <WalletProvider>{children}</WalletProvider>
    </PrivyProvider>
  );
}
