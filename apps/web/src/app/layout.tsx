import { AuthBanner } from "@/components/AuthBanner";
import { StatusBar } from "@/components/StatusBar";
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ThirdEye",
  description: "Solana wallet & token forensics — the eye that sees what the other two cannot.",
  icons: {
    icon: "/favicon.svg",
  },
};

const NAV = [
  { href: "/wallet", label: "WALLET" },
  { href: "/token", label: "TOKEN" },
  { href: "/intel", label: "INTEL" },
  { href: "/settings", label: "SETTINGS" },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-base text-primary antialiased">
        <div className="flex min-h-screen flex-col pb-7">
          <header className="border-b border-border-subtle px-6 py-4">
            <div className="mx-auto flex max-w-6xl items-center justify-between">
              <Link href="/" className="flex items-center gap-2 text-primary hover:text-accent">
                <span className="font-mono text-base font-semibold tracking-wider text-accent">
                  ⌖
                </span>
                <span className="font-sans text-sm font-semibold tracking-[0.2em]">THIRDEYE</span>
              </Link>
              <nav className="flex items-center gap-6">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="font-mono text-2xs tracking-[0.18em] text-secondary transition-colors hover:text-accent"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </header>
          <AuthBanner />
          <main className="flex-1">{children}</main>
        </div>
        <StatusBar />
      </body>
    </html>
  );
}
