/** The day's weather from Open-Meteo, for the weather mark of `caius_header`. */

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 3000;

export interface DayWeather {
    /** A WMO weather code. */
    code: number;
    label: string;
}

/**
 * Fetches the WMO weather code of `date` (`YYYY-MM-DD`) for a place, in that place's time zone.
 * Answers `undefined` on any failure (a date outside the forecast's range, network, status, a body
 * for another day, or no answer within 3 s), so a missing forecast never stops a drawing.
 */
export async function fetchDayWeather(latitude: number, longitude: number, date: string, fetcher: typeof fetch = fetch): Promise<DayWeather | undefined> {
    const query = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        daily: "weather_code",
        timezone: "auto",
        start_date: date,
        end_date: date
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetcher(`${ENDPOINT}?${query}`, { signal: controller.signal });
        if (!response.ok) {
            return undefined;
        }
        const body = await response.json() as { daily?: { time?: unknown[]; weather_code?: unknown[] } } | null;
        const code = body?.daily?.weather_code?.[0];
        return typeof code === "number" && body?.daily?.time?.[0] === date ? { code, label: weatherLabel(code) } : undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/** A short English name for a WMO weather code. */
export function weatherLabel(code: number): string {
    if (code === 0) return "Clear";
    if (code === 1) return "Mostly clear";
    if (code === 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if (code >= 51 && code <= 57) return "Drizzle";
    if (code >= 61 && code <= 67) return "Rain";
    if (code >= 71 && code <= 77) return "Snow";
    if (code >= 80 && code <= 82) return "Showers";
    if (code === 85 || code === 86) return "Snow showers";
    if (code >= 95 && code <= 99) return "Thunderstorm";
    return "Cloudy";
}
