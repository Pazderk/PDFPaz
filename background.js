// Makes clicking the toolbar icon open the docked side panel instead of a popup.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
