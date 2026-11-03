import "@/lib/tracking";   // registers the background task that records the shift
import { ACTION_NAV, handleLaunchResponse, recordAlertError } from "@/lib/alerts";   // registers the one that handles notification buttons
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  // A notification button pressed while the app is on screen. (Pressed with the app closed or in the background,
  // the background task in alerts.ts handles it.)
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => { handleLaunchResponse(r).catch(recordAlertError); });
    return () => sub.remove();
  }, []);
  // Navigate opens the app, so from a cold start the press arrives as the "last response".
  const last = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (last && last.actionIdentifier === ACTION_NAV) handleLaunchResponse(last).catch(recordAlertError);
  }, [last]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: "#0a0a0a" },
            headerTintColor: "#f5f5f5",
            headerTitleStyle: { fontWeight: "700" },
            contentStyle: { backgroundColor: "#0a0a0a" },
          }}
        >
          <Stack.Screen name="index" options={{ title: "Night Route" }} />
          <Stack.Screen name="shift" options={{ title: "Tonight's shift" }} />
          <Stack.Screen name="import" options={{ title: "Add route from PDF" }} />
          <Stack.Screen name="routes" options={{ title: "Manage routes" }} />
          <Stack.Screen name="paused" options={{ title: "Stopped houses" }} />
          <Stack.Screen name="search" options={{ title: "Search houses" }} />
          <Stack.Screen name="add-house" options={{ title: "Add a house" }} />
          <Stack.Screen name="earnings" options={{ title: "Earnings and reports" }} />
          <Stack.Screen name="reminders" options={{ title: "Notifications" }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
