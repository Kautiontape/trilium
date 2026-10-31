import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "com.kautiontape.caius",
    appName: "Caius",
    webDir: "dist",
    // The native bridge logs every plugin result in a debug build, the keystore's connection and
    // every /mcp reply included; none of it may reach logcat.
    loggingBehavior: "none",
    server: {
        androidScheme: "https",
        hostname: "localhost"
    },
    plugins: {
        LocalNotifications: {
            smallIcon: "ic_stat_caius",
            iconColor: "#B5532E"
        }
    }
};

export default config;
