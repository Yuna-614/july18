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
// 국문+숫자는 Pretendard, 영문만 Century Gothic
const KR_FAMILY = "Pretendard";
const LATIN_FAMILY = "Century Gothic";
// 자간(letter spacing), %
const KR_LETTER_SPACING_PERCENT = -1.5;
const LATIN_LETTER_SPACING_PERCENT = -2.5;
// 브랜드 폰트 로드 실패 시 대체 폰트
const FALLBACK_FONT = { family: "Inter", style: "Regular" };
// 텍스트 내 "LIVE" 인라인 로고 치환 시 로고 높이 = fontSize * 이 배율, 로고-텍스트 간 여백 = fontSize * 이 배율
const LIVE_INLINE_LOGO_HEIGHT_RATIO = 1.05;
const LIVE_INLINE_LOGO_GAP_RATIO = 0.15;
// backdrop(가독성 패널) blur 타입의 기본 블러 강도(px)
const DEFAULT_BACKDROP_BLUR_RADIUS = 20;
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
// content 안의 "LIVE" 문자열을 모두 실제 로고 이미지로 치환해서 배치한다. content가 여러 줄("\n" 포함)일
// 수 있으므로 줄 단위로 나눠서 처리한다 — "LIVE"가 없는 줄은 그대로 한 줄 텍스트로, 있는 줄만 "LIVE" 기준으로
// 쪼개 각 조각을 auto-resize 텍스트 노드로 만들어 실제 렌더링 폭을 측정하고, 그 폭을 이어붙여 정렬(align)에
// 맞는 시작 x좌표를 계산한 뒤 순서대로 배치한다. 다음 줄의 y좌표는 이전 줄에서 측정된 실제 높이만큼 내려간다.
function renderTextWithInlineLiveLogo(frame, t, logo) {
    return __awaiter(this, void 0, void 0, function* () {
        const gap = t.fontSize * LIVE_INLINE_LOGO_GAP_RATIO;
        const logoHeight = t.fontSize * LIVE_INLINE_LOGO_HEIGHT_RATIO;
        const logoWidth = logoHeight * logo.aspect;
        let cursorY = t.y;
        for (const line of t.content.split("\n")) {
            const parts = line.includes("LIVE") ? line.split("LIVE") : [line];
            const segments = [];
            for (const part of parts) {
                if (!part) {
                    segments.push(null);
                    continue;
                }
                const node = figma.createText();
                yield applyMixedFontText(node, part, t.fontWeight);
                node.fontSize = t.fontSize;
                node.fills = [{ type: "SOLID", color: { r: t.color[0], g: t.color[1], b: t.color[2] } }];
                node.textAutoResize = "WIDTH_AND_HEIGHT"; // 실제 렌더링 폭/높이를 읽기 위해 콘텐츠에 맞춰 크기 측정
                segments.push(node);
            }
            let totalWidth = 0;
            let lineHeight = t.fontSize * 1.3; // 세그먼트가 전부 빈 값일 때(빈 줄)를 대비한 기본값
            segments.forEach((node, i) => {
                if (node) {
                    totalWidth += node.width;
                    lineHeight = Math.max(lineHeight, node.height);
                }
                if (i < segments.length - 1)
                    totalWidth += gap + logoWidth + gap;
            });
            let cursorX = t.x;
            if (t.align === "RIGHT")
                cursorX = t.x + t.width - totalWidth;
            else if (t.align === "CENTER")
                cursorX = t.x + (t.width - totalWidth) / 2;
            for (let i = 0; i < segments.length; i++) {
                const node = segments[i];
                if (node) {
                    node.x = cursorX;
                    node.y = cursorY;
                    frame.appendChild(node);
                    cursorX += node.width;
                }
                if (i < segments.length - 1) {
                    cursorX += gap;
                    const rect = figma.createRectangle();
                    rect.name = "Live Inline Logo";
                    rect.resize(logoWidth, logoHeight);
                    rect.x = cursorX;
                    rect.y = cursorY + (t.fontSize - logoHeight) / 2;
                    rect.fills = [{ type: "IMAGE", imageHash: logo.imageHash, scaleMode: "FIT" }];
                    frame.appendChild(rect);
                    cursorX += logoWidth + gap;
                }
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
        var _a, _b, _c, _d;
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
            if (inlineLiveLogo && t.content.includes("LIVE")) {
                yield renderTextWithInlineLiveLogo(frame, t, inlineLiveLogo);
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
            for (const h of (_d = t.highlights) !== null && _d !== void 0 ? _d : []) {
                const start = t.content.indexOf(h.text);
                if (start === -1)
                    continue;
                const end = start + h.text.length;
                textNode.setRangeFills(start, end, [
                    { type: "SOLID", color: { r: h.color[0], g: h.color[1], b: h.color[2] } },
                ]);
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
