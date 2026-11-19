import type { Metadata } from "next";
import { Geist, Noto_Sans_Tamil } from "next/font/google";
import { Suspense } from "react";
import AuthGate from "./components/AuthGate";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const notoTamil = Noto_Sans_Tamil({
  variable: "--font-tamil",
  subsets: ["tamil"],
});

export const metadata: Metadata = {
  title: "Opportunity Room · Teemly",
  description: "Your private room for every person and opportunity from your calls",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${notoTamil.variable}`}>
      <body>
        <Suspense fallback={null}>
          <AuthGate>{children}</AuthGate>
        </Suspense>
      </body>
    </html>
  );
}
