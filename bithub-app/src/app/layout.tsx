import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { MockBanner } from "@/components/mock-banner";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Bithub — Strategy Research Platform",
  description: "Research, evaluate, and orchestrate trading strategies. Local-first, audit-friendly.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
      suppressHydrationWarning
    >
      <body className="min-h-full" suppressHydrationWarning>
        <MockBanner />
        <div className="flex h-[calc(100vh-28px)]">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-background">{children}</main>
        </div>
      </body>
    </html>
  );
}
