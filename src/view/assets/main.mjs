import { initializeCharts } from "./charts.mjs";
import { initializeLayout } from "./layout.mjs";
import { initializePerformance, applyCharts, applyGroupVisibility, applyTabularNums } from "./performance.mjs";
import { initializeSettings } from "./settings.mjs";
import { initializeNavigation, updateLocalIntro, switchTab } from "./navigation.mjs";
import { initializeServers, closeRemoteMenu, renderServers } from "./servers.mjs";
import { initializeProcesses } from "./processes.mjs";
import { initializeApp } from "./app.mjs";
import { initializeState } from "./app.mjs";

export function initializeWebview() {
  initializeState();
  initializeCharts();
  initializeLayout();
  initializePerformance();
  initializeSettings({ updateLocalIntro, applyCharts, applyGroupVisibility, applyTabularNums, closeRemoteMenu, renderServers });
  initializeNavigation();
  initializeServers({ updateLocalIntro });
  initializeProcesses({ switchPage:switchTab });
  initializeApp();
}

initializeWebview();
