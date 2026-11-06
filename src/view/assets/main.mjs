import { initializeCharts } from "./charts.mjs";
import { initializeLayout } from "./layout.mjs";
import { initializePerformance, applyCharts, applyGroupVisibility, applyTabularNums, bindInfoButton, refreshInfoPopover } from "./performance.mjs";
import { initializeSettings } from "./settings.mjs";
import { initializeNavigation, updateLocalIntro, switchTab } from "./navigation.mjs";
import { initializeServers, closeRemoteMenu, renderServers } from "./servers.mjs";
import { initializeProcesses } from "./processes.mjs";
import { initializeApp, initializeState } from "./app.mjs";

function initializeWebview() {
  initializeState();
  initializeCharts();
  initializeLayout();
  initializePerformance();
  initializeSettings({ updateLocalIntro, applyCharts, applyGroupVisibility, applyTabularNums, closeRemoteMenu, renderServers });
  initializeNavigation();
  initializeServers({ updateLocalIntro });
  initializeProcesses({ switchPage: switchTab, bindInfoButton, refreshInfoPopover });
  initializeApp();
}

initializeWebview();
