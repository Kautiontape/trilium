import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "com.kautiontape.caius",
    appName: "Caius",
    webDir: "dist",
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
