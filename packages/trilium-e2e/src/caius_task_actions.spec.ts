import { expect, type Page, test } from "@playwright/test";

import App, { isStandalone } from "./support/app";

/** The calendar root the day notes created, when the fixture had none; deleted after the test. */
let createdCalendarRootId: string | null = null;

test.afterEach(async ({ page }) => {
    if (createdCalendarRootId) {
        await api(page, "DELETE", `notes/${createdCalendarRootId}?taskId=caius-e2e-cleanup&last=true`);
        createdCalendarRootId = null;
    }
});

test("A Journal task forwarded to tomorrow from its right-click menu is copied to tomorrow's day note", async ({ page, context }, testInfo) => {
    test.skip(isStandalone(testInfo), "The standalone build has no /api/caius routes.");

    const app = new App(page, context);
    await app.goto();

    const { today, tomorrow } = await page.evaluate(() => {
        const key = (date: Date) => [ date.getFullYear(), date.getMonth() + 1, date.getDate() ]
            .map((part) => String(part).padStart(2, "0")).join("-");
        const now = new Date();
        return { today: key(now), tomorrow: key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) };
    });
    const calendarRootsBefore = await calendarRoots(page);
    const todayNoteId = await dayNoteId(page, today);
    if (!calendarRootsBefore.length) {
        createdCalendarRootId = (await calendarRoots(page))[0] ?? null;
    }
    await api(page, "PUT", `notes/${todayNoteId}/data`, {
        content: "<h2>Morning</h2><ul class=\"todo-list\"><li data-list-item-id=\"ee2e0000000000000000000000000000\">"
            + "<label class=\"todo-list__label\"><input type=\"checkbox\" disabled=\"disabled\">"
            + "<span class=\"todo-list__label__description\">Forward me from the e2e test</span></label></li></ul>"
    });

    await page.evaluate((noteId) => {
        location.hash = `#root/${noteId}`;
    }, todayNoteId);
    const editable = app.currentNoteSplit.locator(".ck-editor__editable");
    const task = editable.locator(".todo-list__label__description", { hasText: "Forward me from the e2e test" });
    const menu = page.locator("#context-menu-container");
    const taskRow = menu.locator(".dropdown-item.caius-task-actions");
    // The browser keeps its native menu on a task until the client has learned that Caius is on,
    // so right-click until Trilium's menu comes up with the Task row.
    await expect(async () => {
        await task.click({ button: "right" });
        await expect(taskRow).toBeVisible({ timeout: 500 });
    }).toPass();

    await taskRow.hover();
    await menu.locator(".dropdown-item > span", { hasText: /^Forward$/ }).hover();
    await menu.locator(".dropdown-item > span", { hasText: /^Tomorrow$/ }).click();
    await expect(page.locator("#toast-container")).toContainText(`Forwarded to ${tomorrow}.`);
    await expect(editable).toHaveAttribute("contenteditable", "true");

    const tomorrowNoteId = await dayNoteId(page, tomorrow);
    const copy = await noteContent(page, tomorrowNoteId);
    expect(copy).toContain("Forward me from the e2e test");
    expect(copy).toContain(`href="#root/${todayNoteId}"`);

    const original = await noteContent(page, todayNoteId);
    expect(original).toMatch(/data-trilium-task-state="[^"]+" title="Rescheduled"/);
    expect(original).toMatch(new RegExp(`<em>scheduled\\s*(?:</em>)?<a href="#root/${tomorrowNoteId}">`));
});

/** Calls the internal API from inside the page, so the request carries the session and CSRF token. */
async function api(page: Page, method: string, path: string, body?: object) {
    const result = await page.evaluate(async ({ method, path, body }) => {
        const response = await fetch(`/api/${path}`, {
            method,
            headers: {
                "x-csrf-token": (window as unknown as { glob: { csrfToken: string } }).glob.csrfToken,
                "Content-Type": "application/json"
            },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await response.text();
        return { status: response.status, json: text ? JSON.parse(text) as unknown : null };
    }, { method, path, body });

    expect(result.status, `${method} /api/${path}`).toBeLessThan(300);
    return result.json;
}

function calendarRoots(page: Page) {
    return api(page, "GET", `search/${encodeURIComponent("#calendarRoot")}`) as Promise<string[]>;
}

async function noteContent(page: Page, noteId: string) {
    const { content } = await api(page, "GET", `notes/${noteId}/blob`) as { content: string };
    return content;
}

async function dayNoteId(page: Page, date: string) {
    const note = await api(page, "GET", `special-notes/days/${date}`) as { noteId: string };
    return note.noteId;
}
