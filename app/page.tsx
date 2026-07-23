import type { Metadata } from "next";
import OracleMonitor from "./oracle-monitor";

export const metadata: Metadata = {
  description:
    "Live onchain participation, DataBus telemetry, and report details for Lido Oracle operators.",
};

export default function Home() {
  return <OracleMonitor />;
}
