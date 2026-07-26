# 소재 제작 AI 에이전트 — 엔지니어링 레퍼런스 (작동 부문)

브랜드 규칙(무엇을 만들지)은 [RULES.md](RULES.md)를 참고. 이 문서는 파이프라인이 "어떻게 동작하는지"만
다룬다. 규칙 문구를 바꿔도 이 문서 내용은 바뀌지 않는다.

## 파이프라인 구조

```
[광고주 시안 이미지] + [원본 고해상도 사진] + [로고 PNG] + [LIVE 로고 PNG]
        │
        ▼
[0. 카테고리 자동 판별 — vision/analyze.js classifyCategory(), Gemini API] (category 미지정 + referenceLibraryDir 지정 시에만)
   - referenceLibraryDir 하위 폴더명을 카테고리 후보로 사용(하드코딩 아님, 폴더 추가만으로 후보 추가됨)
   - 시안 + 카테고리별 대표 샘플을 한 번에 보여주고 가장 유사한 카테고리명(또는 신규 유형이면 "NONE") 판정
        │
        ▼
[1. Vision 분석 — vision/analyze.js, Gemini API]
   - vision/rules.js의 getProductionRules(category)(브랜드 규칙 텍스트, 미등록 카테고리는 공통 규칙만
     fallback)를 프롬프트에 포함
   - 시안과 원본을 함께 모델에 전달
   - cropRect(원본 좌표계 크롭 영역), texts[](1080x1080 기준), logoPlacement, liveBadgePlacement 산출
        │
        ▼
[2. 이미지 크롭/리사이즈 — sharp]
   - 원본 사진을 cropRect로 크롭 후 1080x1080으로 리사이즈 (cover)
        │
        ▼
[output-spec.json 생성]
   - frame, mainImage(크롭된 배경), texts[], logo(base64), liveBadge(base64)
        │
        ▼
[3. Figma 플러그인 — code.ts]
   - 스펙 JSON을 읽어 Figma 캔버스에 실제 레이어 생성
   - 배경 이미지, 텍스트(국문/영문/숫자 자동 폰트 분기), "LIVE" 인라인 로고 치환,
     텍스트 가독성 패널(backdrop), 로고/LIVE뱃지 이미지 배치
```

## 폴더 구조

```
C:\Users\gram\figma-material-agent\
├── RULES.md              — 소재 제작 규칙 (브랜드 규칙 전용 문서)
├── ARCHITECTURE.md        — 이 문서 (엔지니어링 레퍼런스)
├── manifest.json          — Figma 플러그인 정의
├── code.ts                — 플러그인 메인 로직 (스펙 JSON → Figma 노드)
├── ui.html                — 플러그인 UI (JSON 붙여넣기 / 파일 불러오기 / 생성)
├── package.json
├── tsconfig.json
└── vision/
    ├── rules.js            — 브랜드 규칙 (OUTPUT_SIZE, PRODUCTION_RULES) — RULES.md와 1:1 대응
    └── analyze.js          — Gemini Vision 분석 스크립트 (원본+시안 → 스펙 JSON)
```

> `code.ts`는 번들러 없이 `tsc`로 단일 파일만 컴파일하기 때문에 `rules.js`처럼 별도 파일로 규칙을 분리할
> 수 없다. 대신 파일 상단에 "소재 제작 규칙" 배너로 감싼 블록에 브랜드 상수를 모아뒀다 (RULES.md에서
> 각 규칙의 "수정 위치"로 안내).

## 스펙 JSON 포맷 (Figma 플러그인 입력)

```typescript
interface MaterialSpec {
  frame: { name: string; width: number; height: number };
  background?: { type: "solid" | "gradient"; color?: [r,g,b]; gradientStops?: {...}[]; gradientAngle?: number };
  mainImage?: { x: number; y: number; width: number; height: number; base64: string };
  texts: {
    content: string;
    x: number; y: number; width: number; height: number;
    fontSize: number;
    fontWeight: "regular" | "medium" | "bold";
    color: [number, number, number]; // 0~1 RGB
    align?: "LEFT" | "CENTER" | "RIGHT";
    backdrop?: { type: "gradient" | "blur"; color: [r,g,b,a]; blurRadius?: number };
    highlights?: { text: string; color: [r,g,b]; background?: [r,g,b,a]; cornerRadius?: number }[];
  }[];
  logo?: { x: number; y: number; width: number; height: number; base64?: string };
  liveBadge?: { x: number; y: number; width: number; height: number; base64?: string };
}
```

- `mainImage`는 크롭 없이 프레임 전체(보통 x:0,y:0, width/height는 frame과 동일 — 기본 1080x1080이지만
  `vision/analyze.js` 실행 시 `outputWidth`/`outputHeight`(또는 `outputSize: "1200x675"` 같은 문자열)를
  넘기면 가로형/세로형 등 다른 크기도 가능하다)를 채운다. Figma의 `scaleMode: "FILL"`이 자동으로 cover
  크롭을 처리해준다.
- `texts[].content`에 "LIVE"라는 글자가 포함되어 있고 `liveBadge.base64`가 있으면, 그 부분은 텍스트로
  렌더링되지 않고 자동으로 `liveBadge` 이미지로 치환된다 (RULES.md 4번 항목).
- `logo`/`liveBadge`는 `base64`가 없으면 회색 placeholder 사각형으로 렌더링된다 (에셋 준비 전 레이아웃
  확인용).
- `highlights[].background`가 있으면 그 단어 뒤에 둥근 사각형 배경(예: 가격인상 경고 문구의 빨간 박스)이
  자동으로 그려진다. "LIVE" 인라인 치환과 같은 방식(텍스트를 조각내 실제 렌더링 폭을 측정)으로 처리되며,
  한 줄에 LIVE 치환과 배경 강조가 동시에 있어도 함께 처리된다 (RULES.md 7번 항목, `code.ts`의
  `renderTextWithSegments()`).

## 셋업

```powershell
# Node.js 설치 필요 (https://nodejs.org, LTS)

cd C:\Users\gram\figma-material-agent
npm install
npm run build   # scripts/sync-brand-config.js → code.ts → code.js
```

`npm run build`(그리고 `npm run watch`)는 `tsc` 컴파일 전에 `scripts/sync-brand-config.js`를 먼저 실행한다.
이 스크립트가 `brand.config.json`의 값(폰트, 자간, LIVE 인라인 로고 비율, backdrop 기본 블러 강도)을
`code.ts` 상단 `// === BRAND_CONFIG_START` ~ `// === BRAND_CONFIG_END` 마커 사이 상수 블록에 그대로
주입한 뒤 `tsc`가 그 결과를 컴파일한다(자세한 내용은 아래 "브랜드 설정 값 주입" 참고).

> **⚠️ `brand.config.json`을 고친 뒤에는 반드시 `npm run build`를 다시 실행해야 한다.** JSON 파일만
> 고치고 Figma에서 플러그인을 다시 로드해도 반영되지 않는다 — Figma가 실제로 읽는 건 `code.js`이고,
> `code.js`는 `npm run build`를 돌려야만 새 값으로 다시 생성된다.

Figma 데스크톱 앱 → 우클릭 → Plugins → Development → Import plugin from manifest... → `manifest.json`

**Gemini API 키** (https://aistudio.google.com/apikey 무료 발급):
```powershell
[System.Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "발급받은키", "User")
```
새 터미널에서만 자동 반영됨. 기존 세션에서 즉시 쓰려면:
```powershell
$env:GEMINI_API_KEY = [System.Environment]::GetEnvironmentVariable("GEMINI_API_KEY", "User")
```

## 브랜드 설정 값 주입 (`brand.config.json` → `code.ts`)

Figma 플러그인은 번들러 없이 `code.ts` 단일 파일만 `tsc`로 컴파일하는 구조라, 런타임에 `import`/
`require`/`fetch`로 JSON을 읽을 수 없다. 그래서 값 주입은 **빌드 시점**에 텍스트 치환으로 처리한다:

```
[brand.config.json]          [code.ts]
  font.*                        // === BRAND_CONFIG_START ===
  liveInlineLogo.*    ─────▶      const KR_FAMILY = "...";
  backdrop.*                      ...
                                 // === BRAND_CONFIG_END ===
        │                              │
        └──────── scripts/sync-brand-config.js ────────┘
                         │
                         ▼
                   tsc 컴파일 → code.js
```

- `scripts/sync-brand-config.js`가 `code.ts`에서 `// === BRAND_CONFIG_START` ~
  `// === BRAND_CONFIG_END` 사이 텍스트를 찾아 `brand.config.json`의 `font.krFamily`,
  `font.latinFamily`, `font.krLetterSpacingPercent`, `font.latinLetterSpacingPercent`,
  `font.fallback`, `liveInlineLogo.heightRatio`, `liveInlineLogo.gapRatio`,
  `backdrop.defaultBlurRadius` 값으로 만든 상수 선언 블록으로 **치환**해서 `code.ts`에 다시 쓴다.
- 마커가 없거나 한쪽만 있거나 2쌍 이상 발견되면 무엇을 바꿔야 할지 알 수 없으므로 조용히 넘어가지
  않고 에러로 중단한다.
- 마커 밖(렌더링 로직 전체)은 스크립트가 손대지 않는다 — 치환 후 마커 밖 영역이 치환 전과 100% 동일한지
  스크립트 자신이 매번 재검증하고, 다르면 `code.ts`를 덮어쓰지 않고 에러로 중단한다(안전장치).
- `FONT_WEIGHT_MAP`(`regular/medium/bold` → `Regular/Medium/Bold`)은 마커 밖에 남아있다 — 이건
  Figma 폰트 스타일 이름 고정 매핑이지 브랜드 값이 아니므로 `brand.config.json`으로 옮기지 않았다.
- `npm run build`/`npm run watch`는 `tsc`보다 먼저 이 스크립트를 실행한다(`watch` 모드는
  `brand.config.json` 변경을 계속 감시하지 않음 — 최초 1회만 sync하고 이후 `tsc --watch`로 넘어감).

## 실행 (단일 모드 — 원본 1장 + 시안 1장)

```powershell
node vision/analyze.js <원본이미지경로> <시안이미지경로> [로고PNG경로] [LIVE뱃지PNG경로] [출력경로] [카테고리] [프로모션뱃지PNG경로] [레퍼런스라이브러리폴더]
```

Windows 콘솔에서 한글 경로가 깨지는 경우 `--args-file` 옵션 사용:
```powershell
node vision/analyze.js --args-file "C:\경로\args.json"
```
```json
{
  "originalPath": "C:\\...\\원본이미지\\원본.jpg",
  "referencePath": "C:\\...\\시안.png",
  "logoPath": "C:\\...\\요소\\로고.png",
  "liveBadgePath": "C:\\...\\요소\\LIVE 로고.png",
  "outPath": "C:\\...\\output-spec.json",
  "category": "네이버기획전",
  "badgePath": "C:\\...\\요소\\뱃지.png",
  "referenceLibraryDir": "C:\\...\\레퍼런스"
}
```

`category`를 생략하고 `referenceLibraryDir`만 넘기면 카테고리를 AI가 자동 판별한다 (아래 "카테고리 자동
판별" 섹션 참고). `category`를 명시하면 그 값이 항상 우선하고 자동 판별은 아예 실행되지 않는다.

결과로 나온 `output-spec.json`을 Figma 플러그인 UI에서 "파일 불러오기"로 선택하고 "Figma에 생성" 클릭.

## 실행 (배치 모드 — 원본 여러 장 + 시안 여러 장을 한 번에)

원본이미지 폴더와 시안 폴더를 각각 지정하면, **파일명에 포함된 마지막 숫자**를 기준으로 같은 번호끼리
자동으로 짝지어서 순서대로 각각 분석하고, `output-spec-1.json`, `output-spec-2.json`... 처럼 매칭된
쌍의 개수만큼 스펙 파일을 생성한다. 로고/LIVE뱃지/프로모션뱃지/카테고리는 배치 전체에 공통 적용된다.

- 매칭 규칙: `원본_1.jpg` ↔ `시안_1.png`, `원본_2.jpg` ↔ `시안_02.png` 처럼 파일명 속 숫자(마지막 숫자
  그룹)가 같으면 매칭. 폴더 안에 번호가 없는 파일이 있거나 같은 번호가 중복되면 실행 전에 에러로 알려준다.
- 한쪽에만 있는 번호(예: 원본은 있는데 시안이 없는 경우)는 경고만 출력하고 건너뛴다 — 매칭되는 나머지
  쌍은 정상 처리됨.
- Gemini API 레이트리밋(429) 이력이 있어 여러 쌍을 병렬이 아니라 순차로 처리한다. 쌍 하나가 실패해도
  나머지 쌍 처리는 계속 진행하고, 마지막에 성공/실패 요약을 출력한다.

```powershell
node vision/analyze.js --batch <원본이미지폴더> <시안폴더> [로고PNG경로] [LIVE뱃지PNG경로] [출력폴더] [카테고리] [프로모션뱃지PNG경로] [레퍼런스라이브러리폴더]
```

한글 경로가 있는 경우 `--args-file`에 `originalsDir`/`referencesDir`을 넣으면 배치 모드로 자동 판단된다:
```json
{
  "originalsDir": "C:\\...\\원본이미지",
  "referencesDir": "C:\\...\\시안",
  "logoPath": "C:\\...\\요소\\로고.png",
  "liveBadgePath": "C:\\...\\요소\\LIVE 로고.png",
  "outDir": "C:\\...\\output",
  "category": "네이버기획전",
  "badgePath": "C:\\...\\요소\\뱃지.png",
  "referenceLibraryDir": "C:\\...\\레퍼런스"
}
```

`category`를 생략하면 배치 안 시안마다 개별적으로 카테고리를 자동 판별한다(쌍마다 시안이 다르므로
결과가 다를 수 있음).
```powershell
node vision/analyze.js --args-file "C:\경로\batch-args.json"
```

생성된 `output-spec-*.json` 파일들을 Figma 플러그인 UI에서 하나씩 "파일 불러오기" → "Figma에 생성"으로
불러온다 (여러 프레임 한 번에 생성은 아직 미지원 — 다음 단계 후보 참고).

## 실행 (매칭 모드 — 시안을 이미지/PPT로 입력하면 원본을 AI가 자동으로 찾음)

배치 모드는 원본/시안 파일명에 같은 번호가 있어야 하지만, 이 모드는 번호 없이 **내용으로** 자동
매칭한다. 시안 입력을 이미지 파일 하나 또는 PPT(.pptx) 파일로 받는다:

- 이미지 파일이면 그 자체를 시안 1개로 취급.
- PPT면 `ppt/media/` 안의 임베디드 이미지 파일들을 그대로 추출한 뒤(슬라이드를 렌더링하는 게 아니라
  원본 이미지 파일을 꺼내는 방식 — 텍스트가 사진에 합성되지 않고 PPT 네이티브 도형/글상자로만 있는
  슬라이드는 지원 안 함), Gemini에 전부 보여주고 "완성된 광고 시안(문구/로고 합성된 것)"으로 보이는
  이미지만 골라내게 한다. 파일 하나 안에 시안이 여러 장 있어도 각각 별도 시안으로 처리된다.

각 시안마다 원본이미지 폴더 전체(리사이즈한 썸네일)를 한 번의 Gemini 호출로 같이 보여주고, 시안 속
제품/장면과 같은 원본을 내용 기반으로 고르게 한다. 확실히 일치하는 원본이 없으면 그 시안은 건너뛴다.
AI 판단에 의존하므로 어떤 시안이 어떤 원본과 매칭됐는지 콘솔에 항상 출력한다 — 실행 후 꼭 확인할 것.

```powershell
node vision/analyze.js --match <시안 이미지 또는 PPT 경로> <원본이미지폴더> [로고PNG경로] [LIVE뱃지PNG경로] [출력폴더] [카테고리] [프로모션뱃지PNG경로] [레퍼런스라이브러리폴더]
```

한글 경로가 있는 경우 `--args-file`에 `inputPath`/`originalsDir`를 넣으면 매칭 모드로 자동 판단된다:
```json
{
  "inputPath": "C:\\...\\광고 소재 기획안.pptx",
  "originalsDir": "C:\\...\\원본이미지",
  "logoPath": "C:\\...\\요소\\로고.png",
  "liveBadgePath": "C:\\...\\요소\\LIVE 로고.png",
  "outDir": "C:\\...\\output",
  "category": "29cm기획전",
  "badgePath": "C:\\...\\요소\\뱃지.png",
  "referenceLibraryDir": "C:\\...\\레퍼런스"
}
```
```powershell
node vision/analyze.js --args-file "C:\경로\match-args.json"
```

PPT에서 추출한 이미지는 PPT 파일 옆에 `.<PPT파일명>-추출이미지` 폴더로 저장되고(재사용 가능하도록
보존, 자동 삭제 안 함), 이후 흐름은 배치 모드와 동일하게 `output-spec-*.json`을 생성한다.

## 카테고리 자동 판별 (`referenceLibraryDir`)

지금까지는 실행할 때마다 사람이 `category`(네이버기획전/29cm기획전/제품인지/별도기획전)를 직접 지정해야
했다. `referenceLibraryDir`를 넘기고 `category`를 생략하면, 새 시안이 기존 4개 카테고리 중 어디에
가까운지(또는 완전히 새로운 유형인지) `vision/analyze.js`의 `classifyCategory()`가 Gemini로 자동
판별한다.

**우선순위: `category`가 명시되면 항상 그 값을 그대로 쓰고 자동 판별은 아예 실행되지 않는다.** 자동
판별은 `category`를 생략했을 때만 동작하는 보조 기능이다.

`referenceLibraryDir`는 카테고리별로 정리된 대표 시안 폴더를 가리킨다:
```
레퍼런스/
├── 네이버기획전/   (대표 시안 이미지 파일들)
├── 29cm기획전/
├── 제품인지/
└── 별도기획전/
```

동작 방식(`matchOriginalForSian`과 동일한 설계 — 여러 이미지를 인덱스/이름과 함께 한 번에 보여주고
AI가 고르게 함):
1. `fs.readdirSync(referenceLibraryDir, { withFileTypes: true })`로 하위 폴더 이름을 그대로 카테고리
   후보로 사용한다. **하드코딩된 카테고리 목록이 아니므로, `레퍼런스/` 밑에 새 폴더를 추가하는 것만으로
   새 카테고리가 자동으로 후보에 포함된다.**
2. 카테고리 폴더마다 `listImageFiles`로 대표 이미지를 최대 2장(`CATEGORY_SAMPLE_COUNT`) 뽑는다.
3. 새 시안 + 카테고리별 대표 이미지들을 한 번의 Gemini 호출로 함께 보여주고, 레이아웃/스타일(구성 방식,
   텍스트 배치, 뱃지 유무 등 — 색상/제품 종류가 아님)이 가장 유사한 카테고리명을 고르게 한다.
4. 스키마는 `matchedCategory`(string) + `reasoning`(판단 근거, string). 확실히 유사한 카테고리가 없으면
   `matchedCategory`는 `"NONE"`을 반환하고(스키마 레벨에서 nullable을 쓰지 않고 `matchOriginalForSian`의
   `-1` sentinel과 같은 방식), `classifyCategory()`는 이를 `null`로 변환해서 반환한다 — 완전히 새로운
   유형의 소재라는 뜻이다.
5. 판별 결과와 판단 근거는 항상 콘솔에 로그로 남는다(`--match` 모드가 매칭 결과를 항상 로그로 남기는
   관례와 동일 — AI 판단이므로 검증 가능해야 함).

미등록 카테고리(자동 판별이 `null`을 반환했거나, `category`로 `CATEGORY_RULES`에 없는 값이 들어온
경우)는 `vision/rules.js`의 `getProductionRules()`가 에러 대신 `COMMON_RULES`(공통 규칙)만 반환하도록
fallback한다 — 새로운 기획전 유형이 와도 파이프라인이 멈추지 않고 공통 규칙만으로 소재를 생성한다.
기존 4개 카테고리의 동작(각 카테고리 전용 규칙 적용)은 변경되지 않는다.

`referenceLibraryDir`는 `runSingle`/`runBatch`/`runMatchMode` 세 실행 모드 모두에서 지원되며, CLI
포지셔널 인자의 마지막 자리 또는 `--args-file` JSON의 `referenceLibraryDir` 필드로 전달한다(위 각
실행 모드 섹션의 JSON 예시 참고). 배치 모드에서는 시안마다 개별적으로 자동 판별이 실행된다.

> **알아둘 점**: 카테고리 후보 대표 샘플은 `listImageFiles`가 지원하는 확장자(`.jpg/.jpeg/.png/.webp`)만
> 인식한다. 예를 들어 레퍼런스 폴더에 `.svg` 파일만 있거나 폴더가 비어 있으면, 그 카테고리는 이름만으로
> 후보에 오르고 시각적 샘플 없이 판단에 활용된다(에러는 아니지만 판별 정확도가 떨어질 수 있음).

## 트러블슈팅 로그

| 문제 | 원인 | 해결 |
|---|---|---|
| `tsc` 빌드 시 `No inputs were found` | `outDir`/`rootDir`가 프로젝트 루트와 같아서 tsc가 자기 자신을 제외 대상으로 인식 | `outDir`/`rootDir` 옵션 제거 |
| `atob` 타입 에러 | Figma 플러그인 lib에 DOM 타입이 없음 | `declare function atob(...)` 직접 선언 |
| `console`/`fetch` 재선언 충돌 | `@types/node`가 자동으로 딸려 들어와 Figma 전역 타입과 충돌 | tsconfig에 `"types": []` 명시 |
| `require('@google/genai')`가 빈 객체 반환 | 패키지의 CJS 빌드(v0.15.0)가 실제로는 ESM 문법을 포함하는 패키징 버그 | `require()` 대신 `await import("@google/genai")` |
| Gemini 응답 JSON 파싱 실패 | `maxOutputTokens` 부족으로 응답이 중간에 잘림 | `maxOutputTokens` 상향(16384), `thinkingConfig.thinkingBudget` 명시 |
| 색상 값이 `[255,255,255]`로 나옴 | 모델이 0~255 스케일로 반환 | 스키마 description에 "0~1 실수" 명시 + 후처리로 255 스케일 자동 보정 |
| 한글 파일 경로 `ENOENT` (콘솔 인자) | Windows 콘솔에서 커맨드라인 인자로 한글 경로 전달 시 인코딩 깨짐 | `--args-file` 옵션으로 UTF-8 JSON 파일을 통해 경로 전달 |
| 같은 파일인데도 `ENOENT` (경로 문자열은 육안상 동일) | 실제 파일명이 NFD(자모 분리형)로 저장, 전달받은 문자열은 NFC(완성형) | `resolveActualPath()`: 정확히 못 찾으면 디렉터리를 읽어 NFC 기준으로 재매칭 |
| `Cannot write to node with unloaded font "Inter Regular"` | 텍스트 노드 생성 직후 폰트 로드 전에 `fontSize`부터 설정 | 폰트 로드/적용을 `fontSize` 설정보다 먼저 실행 |
| 초기 버전: 원본 대신 배경색+제품크롭으로 재구성 | 스키마가 "배경색 + 작은 이미지 크롭" 구조를 강제 | 원본 이미지를 크롭 없이 프레임 전체 배경으로 사용하는 구조로 재설계 |
| SVG 로고 배치 시 텍스트가 찌그러지며 줄바꿈됨 | `resize()`가 가로/세로를 독립적으로 늘려서 SVG 내부 텍스트 박스 비율이 깨짐 | (이후 로고를 PNG로 전환하며 이 코드는 제거됨. SVG를 다시 쓴다면 `rescale()`로 비율 유지 + contain-fit 필요) |
| 참조 이미지를 잘못 넣어 엉뚱한 카피가 생성됨 | 최근 스크린샷 파일이 실제로는 우리 채팅 화면 스크린샷이었음 (파일 착각) | 이미지를 실제로 Read해서 내용 확인 후 API 호출하는 습관화 |
| API 호출 중 `429 RESOURCE_EXHAUSTED` | Gemini API 프리페이드 크레딧 소진 | AI Studio에서 결제/크레딧 충전 |
| 폴더 구조가 예고 없이 바뀌어 파일을 못 찾음 | 사용자가 `ai 소재 제작` 폴더를 `요소/`, `원본이미지/` 하위 폴더로 재구성 | 매번 실행 전 `fs.readdirSync`로 실제 폴더 구조 확인 |

## 알려진 한계 / 다음 단계 후보

- cropRect 정확도 — 저해상도 시안 vs 고해상도 원본 간 구도 매칭은 모델의 시각적 추정에 의존, 오차 가능
- Figma 플러그인과 vision/analyze.js가 아직 직접 연결되어 있지 않음 (JSON 파일/붙여넣기로 수동 전달)
- 가로형/세로형 소재 사이즈는 `vision/analyze.js` 실행 시 `outputWidth`/`outputHeight`(또는 `outputSize`)를
  넘기면 지원됨(기본은 여전히 정사각형 1080x1080) — 다만 배치/매칭 모드에서 소재마다 다른 크기를 섞어
  쓰는 것은 지원 안 함(한 번의 실행에는 하나의 크기만 적용)
- 여러 텍스트 배리에이션 배치 생성 미지원
- 배치 모드는 `output-spec-N.json`을 여러 개 생성하는 것까지만 지원 — Figma 쪽에서 여러 프레임을 한 번에
  생성하는 기능은 아직 없음 (지금은 하나씩 "파일 불러오기"로 불러와야 함)
- 매칭 모드(`--match`)의 PPT 지원은 임베디드 이미지 파일을 그대로 추출하는 방식 — 슬라이드를 렌더링하지
  않으므로, 텍스트가 사진과 합성되지 않고 PPT 네이티브 도형/글상자로만 있는 시안은 인식 못 함
- 매칭 모드의 원본 매칭은 AI 시각 판단에 의존 — 오매칭 가능성이 있으므로 콘솔에 찍히는 매칭 결과를
  항상 확인해야 함(제품이 유사한데 다른 모델인 경우 등)
- 카테고리 자동 판별(`classifyCategory`)이 `null`(신규 유형)을 반환하면 `getProductionRules`가 공통
  규칙만으로 fallback — 완전히 새로운 유형의 카테고리 전용 규칙(`CATEGORY_RULES`)은 사람이 나중에 직접
  채워 넣어야 함(자동 생성 아님)
- 카테고리 자동 판별의 대표 샘플은 `listImageFiles`가 지원하는 확장자(`.jpg/.jpeg/.png/.webp`)만 인식 —
  레퍼런스 폴더에 `.svg`만 있거나 비어 있으면 그 카테고리는 이름만으로 판단에 참여함(시각적 근거 없음)
