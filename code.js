"use strict";
/// <reference types="@figma/plugin-typings" />
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
figma.showUI(__html__, { width: 420, height: 560 });
// ============================================================
// 소재 제작 규칙 (알로소 Alloso) — 이 블록만 브랜드 규칙이다.
// Figma 플러그인은 번들러 없이 단일 code.ts를 tsc로만 컴파일하기 때문에
// vision/rules.js처럼 별도 파일로 분리할 수 없어, 이 블록 안에 명확히 모아뒀다.
// 아래 이 블록을 벗어난 부분은 전부 "작동" 로직(엔진)이므로 규칙 수정 시 건드릴 필요 없다.
// ============================================================
const FONT_WEIGHT_MAP = {
    regular: "Regular",
    medium: "Medium",
    bold: "Bold",
};
// === BRAND_CONFIG_START (자동 생성 — 직접 수정 금지, brand.config.json을 고치고 npm run build 실행) ===
const KR_FAMILY = "Pretendard";
const LATIN_FAMILY = "Century Gothic";
const KR_LETTER_SPACING_PERCENT = -1.5;
const LATIN_LETTER_SPACING_PERCENT = -2.5;
const FALLBACK_FONT = { family: "Inter", style: "Regular" };
const LIVE_INLINE_LOGO_HEIGHT_RATIO = 1.05;
const LIVE_INLINE_LOGO_GAP_RATIO = 0.15;
const DEFAULT_BACKDROP_BLUR_RADIUS = 20;
const HIGHLIGHT_BADGE_PAD_X_RATIO = 0.28;
const HIGHLIGHT_BADGE_PAD_Y_RATIO = 0.12;
const HIGHLIGHT_BADGE_CORNER_RADIUS = 0;
// === BRAND_CONFIG_END ===
// ============================================================
// 규칙 블록 끝
// ============================================================
const isLatinChar = (ch) => /[A-Za-z]/.test(ch);
function splitRuns(content) {
    const runs = [];
    let i = 0;
    while (i < content.length) {
        const latin = isLatinChar(content[i]);
        let j = i + 1;
        while (j < content.length && isLatinChar(content[j]) === latin)
            j++;
        runs.push({ start: i, end: j, isLatin: latin });
        i = j;
    }
    return runs;
}
function base64ToUint8Array(base64) {
    const raw = base64.replace(/^data:image\/\w+;base64,/, "");
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
function gradientTransformFromAngle(angleDeg) {
    const angleRad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    return [
        [cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin],
        [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos],
    ];
}
function loadFontOrFallback(family, style) {
    return __awaiter(this, void 0, void 0, function* () {
        const font = { family, style };
        try {
            yield figma.loadFontAsync(font);
            return font;
        }
        catch (_a) {
            yield figma.loadFontAsync(FALLBACK_FONT);
            return FALLBACK_FONT;
        }
    });
}
function applyMixedFontText(textNode, content, weight) {
    return __awaiter(this, void 0, void 0, function* () {
        const style = FONT_WEIGHT_MAP[weight];
        const krFont = yield loadFontOrFallback(KR_FAMILY, style);
        const latinFont = yield loadFontOrFallback(LATIN_FAMILY, style);
        textNode.fontName = krFont;
        textNode.characters = content;
        const runs = splitRuns(content);
        for (const run of runs) {
            const font = run.isLatin ? latinFont : krFont;
            textNode.setRangeFontName(run.start, run.end, font);
            const spacingPercent = run.isLatin ? LATIN_LETTER_SPACING_PERCENT : KR_LETTER_SPACING_PERCENT;
            textNode.setRangeLetterSpacing(run.start, run.end, { value: spacingPercent, unit: "PERCENT" });
        }
    });
}
function createTextBackdrop(t) {
    var _a, _b, _c;
    const rect = figma.createRectangle();
    rect.name = "Text Backdrop";
    rect.resize(t.width, t.height);
    rect.x = t.x;
    rect.y = t.y;
    const backdrop = t.backdrop;
    const [r, g, b, a] = backdrop.color;
    if (backdrop.type === "gradient") {
        // 방향(angle)과 정지점(stops)을 시안에 맞게 커스터마이즈할 수 있음.
        // 기본값(각도 270, stops 생략)은 예전 동작(위: 투명 -> 아래: backdrop 색상)과 동일하게 유지된다.
        const stops = (_a = backdrop.stops) !== null && _a !== void 0 ? _a : [
            { position: 0, alpha: 0 },
            { position: 1, alpha: a },
        ];
        rect.fills = [
            {
                type: "GRADIENT_LINEAR",
                gradientTransform: gradientTransformFromAngle((_b = backdrop.angle) !== null && _b !== void 0 ? _b : 270),
                gradientStops: stops.map((s) => ({
                    position: s.position,
                    color: { r, g, b, a: s.alpha },
                })),
            },
        ];
    }
    else {
        rect.fills = [{ type: "SOLID", color: { r, g, b }, opacity: a }];
        rect.effects = [
            {
                type: "BACKGROUND_BLUR",
                blurType: "NORMAL",
                radius: (_c = backdrop.blurRadius) !== null && _c !== void 0 ? _c : DEFAULT_BACKDROP_BLUR_RADIUS,
                visible: true,
            },
        ];
    }
    return rect;
}
function tokenizeLine(line, highlights, hasLiveLogo) {
    var _a;
    const markers = [];
    if (hasLiveLogo) {
        let idx = line.indexOf("LIVE");
        while (idx !== -1) {
            markers.push({ start: idx, end: idx + 4, token: { kind: "live" } });
            idx = line.indexOf("LIVE", idx + 4);
        }
    }
    for (const h of highlights) {
        if (!h.background)
            continue;
        let idx = line.indexOf(h.text);
        while (idx !== -1) {
            markers.push({
                start: idx,
                end: idx + h.text.length,
                token: {
                    kind: "highlight",
                    text: h.text,
                    color: h.color,
                    background: h.background,
                    cornerRadius: (_a = h.cornerRadius) !== null && _a !== void 0 ? _a : HIGHLIGHT_BADGE_CORNER_RADIUS,
                    fontWeight: h.fontWeight,
                },
            });
            idx = line.indexOf(h.text, idx + h.text.length);
        }
    }
    markers.sort((a, b) => a.start - b.start);
    const tokens = [];
    let cursor = 0;
    for (const m of markers) {
        if (m.start < cursor)
            continue; // 겹치는 마커는 먼저 온 것을 우선하고 뒤엣것은 무시
        if (m.start > cursor)
            tokens.push({ kind: "text", text: line.slice(cursor, m.start) });
        tokens.push(m.token);
        cursor = m.end;
    }
    if (cursor < line.length || tokens.length === 0)
        tokens.push({ kind: "text", text: line.slice(cursor) });
    return tokens;
}
// content 안의 "LIVE" 치환 이미지와 배경 박스가 있는 highlight를 함께 처리하며 한 줄씩 배치한다(둘 다 없는
// 조각은 그냥 일반 텍스트). 각 조각을 auto-resize 텍스트 노드로 만들어 실제 렌더링 폭을 측정하고, 그 폭을
// 이어붙여 정렬(align)에 맞는 시작 x좌표를 계산한 뒤 순서대로 배치한다. 다음 줄의 y좌표는 이전 줄에서
// 측정된 실제 높이만큼 내려간다.
function renderTextWithSegments(frame, t, logo) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const hasLiveLogo = !!logo && t.content.includes("LIVE");
        const gap = t.fontSize * LIVE_INLINE_LOGO_GAP_RATIO;
        const logoHeight = t.fontSize * LIVE_INLINE_LOGO_HEIGHT_RATIO;
        const logoWidth = logo ? logoHeight * logo.aspect : 0;
        const padX = t.fontSize * HIGHLIGHT_BADGE_PAD_X_RATIO;
        const padY = t.fontSize * HIGHLIGHT_BADGE_PAD_Y_RATIO;
        let cursorY = t.y;
        for (const line of t.content.split("\n")) {
            const tokens = tokenizeLine(line, (_a = t.highlights) !== null && _a !== void 0 ? _a : [], hasLiveLogo);
            const measured = [];
            for (const token of tokens) {
                if (token.kind === "live") {
                    measured.push({ kind: "live" });
                    continue;
                }
                if (!token.text)
                    continue;
                const node = figma.createText();
                const weight = token.kind === "highlight" ? (_b = token.fontWeight) !== null && _b !== void 0 ? _b : t.fontWeight : t.fontWeight;
                yield applyMixedFontText(node, token.text, weight);
                node.fontSize = t.fontSize;
                const color = token.kind === "highlight" ? token.color : t.color;
                node.fills = [{ type: "SOLID", color: { r: color[0], g: color[1], b: color[2] } }];
                node.textAutoResize = "WIDTH_AND_HEIGHT"; // 실제 렌더링 폭/높이를 읽기 위해 콘텐츠에 맞춰 크기 측정
                if (token.kind === "highlight") {
                    measured.push({ kind: "highlight", node, background: token.background, cornerRadius: token.cornerRadius });
                }
                else {
                    measured.push({ kind: "text", node });
                }
            }
            let totalWidth = 0;
            let lineHeight = t.fontSize * 1.3; // 조각이 전부 빈 값일 때(빈 줄)를 대비한 기본값
            measured.forEach((m) => {
                if (m.kind === "live") {
                    totalWidth += logoWidth;
                    lineHeight = Math.max(lineHeight, logoHeight);
                }
                else if (m.kind === "highlight") {
                    totalWidth += m.node.width + padX * 2;
                    lineHeight = Math.max(lineHeight, m.node.height);
                }
                else {
                    totalWidth += m.node.width;
                    lineHeight = Math.max(lineHeight, m.node.height);
                }
            });
            // LIVE 조각 앞뒤로는 기존과 동일하게 gap을 더한다. highlight는 패딩 자체가 여백 역할을 하므로
            // 추가 gap을 두지 않는다(시안에서 배경 박스가 옆 텍스트와 거의 붙어 있는 모양과 일치).
            tokens.forEach((token, i) => {
                if (token.kind !== "live")
                    return;
                if (i > 0)
                    totalWidth += gap;
                if (i < tokens.length - 1)
                    totalWidth += gap;
            });
            let cursorX = t.x;
            if (t.align === "RIGHT")
                cursorX = t.x + t.width - totalWidth;
            else if (t.align === "CENTER")
                cursorX = t.x + (t.width - totalWidth) / 2;
            for (let i = 0; i < measured.length; i++) {
                const m = measured[i];
                if (tokens[i].kind === "live" && i > 0)
                    cursorX += gap;
                if (m.kind === "live") {
                    const rect = figma.createRectangle();
                    rect.name = "Live Inline Logo";
                    rect.resize(logoWidth, logoHeight);
                    rect.x = cursorX;
                    rect.y = cursorY + (t.fontSize - logoHeight) / 2;
                    rect.fills = [{ type: "IMAGE", imageHash: logo.imageHash, scaleMode: "FIT" }];
                    frame.appendChild(rect);
                    cursorX += logoWidth;
                }
                else if (m.kind === "highlight") {
                    const boxWidth = m.node.width + padX * 2;
                    const boxHeight = m.node.height + padY * 2;
                    const bg = figma.createRectangle();
                    bg.name = "Highlight Background";
                    bg.resize(boxWidth, boxHeight);
                    bg.cornerRadius = m.cornerRadius;
                    bg.x = cursorX;
                    bg.y = cursorY - padY;
                    const [r, g, b, a] = m.background;
                    bg.fills = [{ type: "SOLID", color: { r, g, b }, opacity: a }];
                    frame.appendChild(bg);
                    m.node.x = cursorX + padX;
                    m.node.y = cursorY;
                    frame.appendChild(m.node);
                    cursorX += boxWidth;
                }
                else {
                    m.node.x = cursorX;
                    m.node.y = cursorY;
                    frame.appendChild(m.node);
                    cursorX += m.node.width;
                }
                if (tokens[i].kind === "live" && i < measured.length - 1)
                    cursorX += gap;
            }
            cursorY += lineHeight;
        }
    });
}
function placeImageAsset(frame, asset, name) {
    if (!asset)
        return;
    const rect = figma.createRectangle();
    rect.name = asset.base64 ? name : `${name} Placeholder`;
    rect.resize(asset.width, asset.height);
    rect.x = asset.x;
    rect.y = asset.y;
    if (asset.base64) {
        const imageHash = figma.createImage(base64ToUint8Array(asset.base64)).hash;
        rect.fills = [{ type: "IMAGE", imageHash, scaleMode: "FIT" }];
    }
    else {
        rect.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 } }];
    }
    frame.appendChild(rect);
}
function buildMaterial(spec) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e;
        const frame = figma.createFrame();
        frame.name = spec.frame.name || "Generated Material";
        frame.resize(spec.frame.width, spec.frame.height);
        frame.x = figma.viewport.center.x - spec.frame.width / 2;
        frame.y = figma.viewport.center.y - spec.frame.height / 2;
        if (spec.background && spec.background.type === "solid" && spec.background.color) {
            const [r, g, b] = spec.background.color;
            frame.fills = [{ type: "SOLID", color: { r, g, b } }];
        }
        else if (spec.background && spec.background.type === "gradient" && spec.background.gradientStops) {
            frame.fills = [
                {
                    type: "GRADIENT_LINEAR",
                    gradientTransform: gradientTransformFromAngle(spec.background.gradientAngle || 0),
                    gradientStops: spec.background.gradientStops.map((s) => ({
                        position: s.position,
                        color: { r: s.color[0], g: s.color[1], b: s.color[2], a: s.color[3] },
                    })),
                },
            ];
        }
        if (spec.mainImage) {
            const imageHash = figma.createImage(base64ToUint8Array(spec.mainImage.base64)).hash;
            const rect = figma.createRectangle();
            rect.name = "Main Image";
            rect.resize(spec.mainImage.width, spec.mainImage.height);
            rect.x = spec.mainImage.x;
            rect.y = spec.mainImage.y;
            rect.fills = [{ type: "IMAGE", imageHash, scaleMode: "FILL" }];
            frame.appendChild(rect);
        }
        let inlineLiveLogo = null;
        const liveLogoBase64 = (_b = (_a = spec.liveBadge) === null || _a === void 0 ? void 0 : _a.base64) !== null && _b !== void 0 ? _b : (_c = spec.liveLogoAsset) === null || _c === void 0 ? void 0 : _c.base64;
        if (liveLogoBase64) {
            const image = figma.createImage(base64ToUint8Array(liveLogoBase64));
            const size = yield image.getSizeAsync();
            inlineLiveLogo = { imageHash: image.hash, aspect: size.width / size.height };
        }
        for (const t of spec.texts) {
            if (t.backdrop) {
                frame.appendChild(createTextBackdrop(t));
            }
            const hasBackgroundHighlight = ((_d = t.highlights) !== null && _d !== void 0 ? _d : []).some((h) => h.background);
            if ((inlineLiveLogo && t.content.includes("LIVE")) || hasBackgroundHighlight) {
                yield renderTextWithSegments(frame, t, inlineLiveLogo);
                continue;
            }
            const textNode = figma.createText();
            yield applyMixedFontText(textNode, t.content, t.fontWeight);
            textNode.resize(t.width, t.height);
            textNode.x = t.x;
            textNode.y = t.y;
            textNode.fontSize = t.fontSize;
            textNode.fills = [{ type: "SOLID", color: { r: t.color[0], g: t.color[1], b: t.color[2] } }];
            if (t.align)
                textNode.textAlignHorizontal = t.align;
            for (const h of (_e = t.highlights) !== null && _e !== void 0 ? _e : []) {
                const start = t.content.indexOf(h.text);
                if (start === -1)
                    continue;
                const end = start + h.text.length;
                textNode.setRangeFills(start, end, [
                    { type: "SOLID", color: { r: h.color[0], g: h.color[1], b: h.color[2] } },
                ]);
                if (h.fontWeight) {
                    // 강조 구간의 첫 글자 기준으로 이 구간의 폰트 패밀리를 판단한다(구간 내 국문/영문 혼용은 지원 안 함).
                    const family = isLatinChar(h.text[0]) ? LATIN_FAMILY : KR_FAMILY;
                    const font = yield loadFontOrFallback(family, FONT_WEIGHT_MAP[h.fontWeight]);
                    textNode.setRangeFontName(start, end, font);
                }
            }
            frame.appendChild(textNode);
        }
        placeImageAsset(frame, spec.logo, "Logo");
        placeImageAsset(frame, spec.liveBadge, "Live Badge");
        placeImageAsset(frame, spec.badge, "Promo Badge");
        figma.currentPage.appendChild(frame);
        figma.viewport.scrollAndZoomIntoView([frame]);
        figma.currentPage.selection = [frame];
        return frame;
    });
}
figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
    if (msg.type === "generate" && msg.spec) {
        try {
            const spec = JSON.parse(msg.spec);
            yield buildMaterial(spec);
            figma.ui.postMessage({ type: "success" });
        }
        catch (e) {
            figma.ui.postMessage({ type: "error", message: e.message });
        }
    }
    if (msg.type === "close") {
        figma.closePlugin();
    }
});
