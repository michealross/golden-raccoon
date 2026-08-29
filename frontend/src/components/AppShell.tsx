import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { WalletConnectButton } from "@/components/WalletConnectButton";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/agents", label: "Agents" },
  { href: "/scan", label: "Scan" },
  { href: "/strategy", label: "Strategy" },
  { href: "/alerts", label: "Alerts" },
  { href: "/history", label: "History" },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-hidden bg-[#050505] text-white">
      <header className="sticky top-0 z-30 border-b border-white/8 bg-[#050505]/78 backdrop-blur-2xl">
        <div className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-3">
            <Image
              src="/brand/logo.png"
              alt="Golden Raccoon guardian emblem"
              width={44}
              height={44}
              className="rounded-2xl border border-white/10"
              priority
            />
            <div>
              <div className="text-sm font-semibold tracking-[0.18em] text-[#d9a441]">GOLDEN RACCOON</div>
            </div>
          </Link>
          <nav className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 md:flex">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full px-4 py-2 text-sm text-white/64 transition hover:bg-white/8 hover:text-white"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <WalletConnectButton />
        </div>
        <nav className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto px-5 pb-3 md:hidden">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className="shrink-0 rounded-full px-3 py-2 text-sm text-white/64 hover:bg-white/8 hover:text-white">
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-7xl px-5 py-6 sm:px-8 sm:py-8">{children}</main>
    </div>
  );
}
