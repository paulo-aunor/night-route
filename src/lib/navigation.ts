import { Linking, Platform } from "react-native";
import type { Subscriber } from "@/types";

export function fullAddress(s: Subscriber): string {
  return `${s.address}, ${s.city}, ON ${s.postal}`;
}

export async function openInGoogleMaps(s: Subscriber): Promise<void> {
  const q = encodeURIComponent(fullAddress(s));
  const intent = `google.navigation:q=${q}&mode=d`;
  const webFallback = `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;

  if (Platform.OS === "android") {
    const supported = await Linking.canOpenURL(intent);
    if (supported) {
      await Linking.openURL(intent);
      return;
    }
  }
  await Linking.openURL(webFallback);
}
