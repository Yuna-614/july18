# 소재 제작 AI 에이전트 — 엔지니어링 레퍼런스 (작동 부문)

브랜드 규칙(무엇을 만들지)은 [RULES.md](RULES.md)를 참고. 이 문서는 파이프라인이 "어떻게 동작하는지"만
다룬다. 규칙 문구를 바꿔도 이 문서 내용은 바뀌지 않는다.

## 파이프라인 구조

```
[광고주 시안 이미지] + [원본 고해상도 사진] + [로고 PNG] + [LIVE 로고 PNG]
        │
        ▼
[1. Vision 분석 — vision/analyze.js, Gemini API]
   - vision/rules.js의 PRODUCTION_RULES(브랜드 규칙 텍스트)를 프롬프트에 포함
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
    highlights?: { text: string; color: [r,g,b] }[];
  }[];
  logo?: { x: number; y: number; width: number; height: number; base64?: string };
  liveBadge?: { x: number; y: number; width: number; height: number; base64?: string };
}
```

- `mainImage`는 크롭 없이 프레임 전체(보통 x:0,y:0,width:1080,height:1080)를 채운다. Figma의
  `scaleMode: "FILL"`이 자동으로 cover 크롭을 처리해준다.
- `texts[].content`에 "LIVE"라는 글자가 포함되어 있고 `liveBadge.base64`가 있으면, 그 부분은 텍스트로
  렌더링되지 않고 자동으로 `liveBadge` 이미지로 치환된다 (RULES.md 4번 항목).
- `logo`/`liveBadge`는 `base64`가 없으면 회색 placeholder 사각형으로 렌더링된다 (에셋 준비 전 레이아웃
  확인용).

## 셋업

```powershell
# Node.js 설치 필요 (https://nodejs.org, LTS)

cd C:\Users\gram\figma-material-agent
npm install
npm run build   # code.ts → code.js
```

Figma 데스크톱 앱 → 우클릭 → Plugins → Development → Import plugin from manifest... → `manifest.json`

**Gemini API 키** (https://aistudio.google.com/apikey 무료 발급):
```powershell
[System.Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "발급받은키", "User")
```
새 터미널에서만 자동 반영됨. 기존 세션에서 즉시 쓰려면:
```powershell
$env:GEMINI_API_KEY = [System.Environment]::GetEnvironmentVariable("GEMINI_API_KEY", "User")
```

## 실행 (단일 모드 — 원본 1장 + 시안 1장)

```powershell
node vision/analyze.js <원본이미지경로> <시안이미지경로> [로고PNG경로] [LIVE뱃지PNG경로] [출력경로] [카테고리] [프로모션뱃지PNG경로]
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
  "badgePath": "C:\\...\\요소\\뱃지.png"
}
```

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
node vision/analyze.js --batch <원본이미지폴더> <시안폴더> [로고PNG경로] [LIVE뱃지PNG경로] [출력폴더] [카테고리] [프로모션뱃지PNG경로]
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
  "badgePath": "C:\\...\\요소\\뱃지.png"
}
```
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
node vision/analyze.js --match <시안 이미지 또는 PPT 경로> <원본이미지폴더> [로고PNG경로] [LIVE뱃지PNG경로] [출력폴더] [카테고리] [프로모션뱃지PNG경로]
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
  "badgePath": "C:\\...\\요소\\뱃지.png"
}
```
```powershell
node vision/analyze.js --args-file "C:\경로\match-args.json"
```

PPT에서 추출한 이미지는 PPT 파일 옆에 `.<PPT파일명>-추출이미지` 폴더로 저장되고(재사용 가능하도록
보존, 자동 삭제 안 함), 이후 흐름은 배치 모드와 동일하게 `output-spec-*.json`을 생성한다.

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

- `highlights`(부분 색상 강조)는 텍스트 전체 단일 노드에만 적용 가능 — "LIVE" 인라인 치환처럼 텍스트를
  쪼개서 배치하는 경로에서는 적용 안 됨 (현재는 필요 없음, LIVE는 항상 이미지로 치환되므로)
- cropRect 정확도 — 저해상도 시안 vs 고해상도 원본 간 구도 매칭은 모델의 시각적 추정에 의존, 오차 가능
- Figma 플러그인과 vision/analyze.js가 아직 직접 연결되어 있지 않음 (JSON 파일/붙여넣기로 수동 전달)
- 정사각형 외 세로형/가로형 소재 사이즈 미지원 (OUTPUT_SIZE 고정)
- 여러 텍스트 배리에이션 배치 생성 미지원
- 배치 모드는 `output-spec-N.json`을 여러 개 생성하는 것까지만 지원 — Figma 쪽에서 여러 프레임을 한 번에
  생성하는 기능은 아직 없음 (지금은 하나씩 "파일 불러오기"로 불러와야 함)
- 매칭 모드(`--match`)의 PPT 지원은 임베디드 이미지 파일을 그대로 추출하는 방식 — 슬라이드를 렌더링하지
  않으므로, 텍스트가 사진과 합성되지 않고 PPT 네이티브 도형/글상자로만 있는 시안은 인식 못 함
- 매칭 모드의 원본 매칭은 AI 시각 판단에 의존 — 오매칭 가능성이 있으므로 콘솔에 찍히는 매칭 결과를
  항상 확인해야 함(제품이 유사한데 다른 모델인 경우 등)
