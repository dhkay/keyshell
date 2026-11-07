# KeyShell

[한국어](#한국어) · [English](#english)

<a id="한국어"></a>

Windows·macOS·Linux용 SSH 데스크톱 앱입니다. 터미널과 AI 대화를 나누고, 선택한 출력 또는 세션별 자동 조언에 동의한 새 출력만 ChatGPT에 공유합니다. 제안된 명령은 전체 내용과 접속 대상을 확인한 뒤 한 번 실행합니다.

현재 개발 중입니다. Windows x64에서 실제 SSH·화면 통합 테스트를 통과했습니다. 실제 사용자 ChatGPT 인증, macOS·arm64 실행과 서명·공증 검증은 남아 있습니다.

## 개발 실행

Node.js 22 이상이 필요합니다.

Electron 45의 런타임 하한은 Windows 10, macOS 13 Ventura입니다. 빌드 대상은 두 운영체제의 x64·arm64이며, 각 환경의 실제 검증 결과는 출시 전에 확인해야 합니다.

```sh
npm ci
npm start
```

처음에는 저장된 연결과 AI 계정이 없습니다. AI 로그인 없이 SSH를 사용할 수 있습니다. SSH 비밀번호와 개인 키 암호는 저장하지 않습니다. 프로필과 확인한 호스트 키는 로컬에 저장합니다.

공식 ChatGPT 로그인은 [오픈소스 앱용 등록 흐름](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)을 사용합니다. 브라우저에서 계정과 권한을 확인해야 하며, 실제 이용 권한과 사용량 제한은 해당 계정에 적용됩니다. 로그인 유지는 사용자가 선택하며 OS 암호화 저장을 사용할 수 없으면 메모리에서만 유지됩니다.

## 메시지 전송과 AI 터미널 공유

- 기본은 **전송 전 확인 OFF**입니다. Enter 또는 `전송 ↵`으로 질문과 직접 첨부한 내용을 바로 보내고, Shift+Enter로 줄바꿈합니다. 한글 조합 확정 Enter는 전송하지 않습니다.
- `전송 전 확인 ON`을 선택하면 Enter로 전체 요청을 확인·편집·취소한 뒤 한 번 전송합니다. 두 모드 모두 전송 전에 로컬 가림을 적용하며, 가림이 모든 비밀을 찾는다고 보장하지 않습니다.
- `AI 터미널 공유`은 기본 OFF입니다. 연결된 현재 SSH 세션에서 계정·모델·공유 범위를 확인하고 동의한 뒤 켤 수 있습니다. 일반 질문의 미리보기 설정과 별도의 자동 공유 동의입니다.
- 자동 조언은 활성화 이후 앱에서 새로 수신한 출력만 최대 8KiB 모읍니다. 2초간 출력이 없거나 최대 10초 모으면 안내를 요청하되 최소 60초 간격으로 보내며 횟수 제한은 없습니다. 계속 공유할 수 있도록 이전 AI 맥락은 최근 64KiB로 정리하고 정리 여부를 표시합니다. 기존 대화도 요청에 포함되므로 전체 요청 크기는 출력 제한보다 클 수 있습니다.
- 자동 조언은 끄기·탭 이동·연결 종료·계정/모델 변경·새 대화·요청 오류·화면 재시작 때 중지합니다. 이미 전송한 정보는 회수하지 못합니다. 화면 캡처·다른 세션·키보드 입력·인증정보 저장소는 자동으로 읽지 않습니다.
- 미리보기 설정과 자동 조언 동의는 현재 앱 실행 중에만 유지합니다. 일반 모드의 AI 제안 명령은 별도 실행 검토와 승인을 거칩니다. AI 권한 ON에서는 같은 채팅창에서 질문에 답하거나 요청한 서버 작업을 순차 실행합니다.

## 채팅 위치와 실행 결과 분석

채팅을 위로 스크롤하면 새 답변과 실행 안내가 와도 읽던 위치를 유지합니다. 빈 입력창에서 Enter를 누르면 즉시 맨 아래로 이동하고 새 내용을 따라갑니다. Shift+Enter와 한글 조합 중 Enter는 기존 입력 동작을 유지합니다.

`Review & run`의 **실행 결과를 AI에 보내고 다음 작업 제안 받기**를 선택하면, 명령 종료 후 실제 출력(최근 16KiB)·종료 코드·종료 상태를 묶어 분석합니다. AI 터미널 공유를 켜지 않아도 동작합니다. 다음 제안 명령은 일반 모드에서 자동 실행하지 않습니다. 출력이 없는 명령과 실패·불확실한 종료도 분석 대상이며, 연결·탭·계정·모델 변경이나 취소 후 결과는 보내지 않습니다.

## AI 전송 전 민감정보 가림

- 기본 적용이며 끄는 옵션은 없습니다. 질문·첨부 로그·이전 대화·자동 터미널 공유·승인 실행 결과·위임 목표와 진행 요약을 로컬에서 검사한 뒤 AI 요청을 만듭니다. 전송 전 확인에는 실제 전송할 가려진 본문을 표시합니다.
- IPv4/IPv6, 비밀번호·패스프레이즈·API 키, 인증 토큰/JWT·쿠키·개인키 블록, DB URL의 비밀번호, 일부 CLI 비밀번호 옵션과 알려진 서비스 키 형식을 `****`로 바꿉니다. SSH에 입력한 비밀번호/패스프레이즈는 이름표 없는 복사본과 JSON/URL 이스케이프 형태도 비교합니다. 이 비교 목록은 원문 대신 앱 실행 동안만 유지하는 keyed hash를 사용합니다.
- 민감정보 목록이 바뀌면 오래된 전송 확인을 무효화하고 대기 중 요청도 전송 전에 차단합니다. 검사를 완료하지 못하면 전송하지 않습니다. `****`가 든 AI 명령은 실제 값으로 복원하지 않으며 실행을 멈추고 직접 입력을 요청합니다.
- 본인의 로컬 SSH 화면·클립보드·접속 프로필 및 서버 로그/셸 히스토리 원본을 수정하는 기능은 아닙니다. AI에 보내는 로그의 사본에 적용합니다. 그 밖의 내용은 외부 AI로 전송됩니다. 형식 없는 미등록 비밀, 임의 인코딩, 잘려서 식별할 수 없는 값 등 모든 비밀을 완벽히 탐지한다고 보장하지 않습니다. 도메인·사용자명·이메일·파일 경로·업무 데이터도 자동으로 모두 가려지는 것은 아닙니다.


### AI 권한과 같은 채팅창

SSH 세션에서 **AI 권한 OFF**이면 AI는 질문에 답하고 명령을 제안하지만 자동으로 실행하지 않습니다. **AI 권한 ON**이면 같은 채팅창에서 일반 질문은 바로 답하고, 사용자가 서버 점검·설치·설정 변경을 요청한 경우에만 작업 목록을 만들고 명령을 순차 실행합니다. 작업 중 보낸 추가 메시지는 현재 명령이 끝난 뒤 다음 판단에 반영합니다. 완료·추가 입력 필요·직접 조작 후에도 같은 SSH 세션의 권한은 ON으로 유지되며, OFF 버튼으로 끕니다. 탭·계정·모델·연결을 바꾸면 다른 대상에 실행 권한이 이어지지 않습니다.

## 서버 작업 위임

AI는 함수 도구로 작업 목록을 만들고 현재 SSH 터미널에 명령을 한 번에 하나씩 요청합니다. 각 명령의 종료 상태와 민감정보를 가린 출력을 모델에 돌려준 뒤 다음 단계를 결정합니다. 명령 실행 중에는 3초마다 앱 내부의 SSH 실행 상태를 확인하며 실행 중인 터미널에 확인 명령을 끼워 넣지 않습니다. 점검·설치·업데이트·취약점 검사·보안 패치 요청을 같은 채팅에서 이어서 처리할 수 있습니다. 항목을 건너뛰거나 확인되지 않은 결과를 완료로 처리하지 않고, 완료 후에는 짧은 결과를 보고합니다.



SSH 연결과 ChatGPT 로그인 후 **AI 권한 OFF**를 눌러 켜면 기존 채팅창에서 일반 질문과 서버 작업을 함께 요청할 수 있습니다. 질문은 바로 답하고, `nginx, PHP 8.5, MariaDB 설치 후 상태를 확인해줘`처럼 서버 점검·설치·설정 변경을 요청하면 작업 목록을 만들고 명령을 순차 실행합니다. 실행 결과와 새 메시지는 같은 대화에서 이어집니다. 목표별 추가 동의창은 없습니다. 권한을 끄거나 탭·계정·모델·연결을 바꾸면 다른 대상에 실행 권한이 이어지지 않습니다.

- AI는 OS와 기존 구성을 먼저 확인하고, 설치·설정 변경 및 검증을 순차적으로 요청합니다. 원격 명령은 현재 SSH 계정 권한으로 실행합니다. 비밀번호 입력이 필요한 설치는 수동 작업으로 전환합니다.
- 위임의 단계 수·전체 작업 시간·명령 실행 시간에는 인위적인 제한이 없습니다. 전체 계획과 누적 진행 상황을 유지하며 결과에 따라 다음 단계를 결정합니다. 완료·추가 입력 필요·불확실한 종료·AI 오류 시 자동 재시도 없이 멈춥니다.
- **AI 권한 ON · 끄기**, 응답 취소, 탭·계정·모델·연결·대화 변경, 앱 재시작으로 추가 실행을 중단합니다. 실행 중인 공유 터미널에는 Ctrl+C로 중단을 요청하지만 종료나 변경 취소를 보장하지 않으며, 이미 적용한 변경을 자동 복구하지 않습니다.
- 삭제·대화형 명령·디스크 관리·재부팅·저장소 추가 등 탐지한 추가 확인 작업은 일반 검토로 넘깁니다. 임의 셸의 실제 효과와 목표 준수 여부를 완전히 판별하는 샌드박스는 아니므로, 위임은 해당 SSH 계정 권한으로 서버를 변경할 수 있는 기능입니다.
- 서버 출력은 비신뢰 데이터로 처리하고 로컬 가림을 적용합니다. 가림과 위험 탐지는 완벽하지 않습니다. 외부 AI 서비스의 계정 권한·사용량 한도는 계속 적용됩니다.

## 사람과 AI의 공유 터미널

승인 실행과 위임 명령은 사람이 쓰는 **같은 SSH 터미널**에 `[AI]`로 표시하고, 결과와 종료 코드도 같은 화면에 출력합니다. 사람이 이동한 폴더·설정한 환경 변수를 AI가 이어 쓰고, AI가 바꾼 경로·환경도 다음 직접 입력에 유지됩니다. 별도 서버 에이전트 설치는 필요하지 않습니다. 명령은 현재 셸의 설정에 따라 서버의 셸 히스토리에 기록될 수 있습니다.

- 셸이 새 프롬프트를 반환했는지 확인한 뒤 AI 명령을 보냅니다. 입력 중인 줄이나 실행 중인 프로그램에 명령을 끼워 넣지 않습니다. 출력을 잠시 멈춘 것을 완료로 간주하지 않습니다.
- AI 실행 중에는 일반 입력·붙여넣기 충돌을 막습니다. **직접 조작** 또는 선택 영역이 없는 Ctrl+C로 AI를 멈추고 조작권을 가져올 수 있습니다. 실행이 끝났다고 확인하지 못하면 결과는 불확실로 기록합니다.
- AI가 다음 단계를 계획 중일 때 사람이 터미널에 입력하거나 붙여넣으면 현재 작업을 중지합니다. 현재 작업만 중지하고 AI 권한 ON은 유지합니다. 사용자가 다음 채팅 목표를 보낼 때까지 AI가 자동으로 조작권을 되가져가지 않습니다.
- Bash·Zsh의 프롬프트 훅을 현재 셸 프로세스에 연결해 종료를 확인합니다. 서버 시작 파일을 수정하지 않습니다. 셸 연동이 확인되지 않거나 사용자가 훅을 변경하면 AI 실행을 허용하지 않고 직접 터미널 조작을 유지합니다.
- 전체 화면 프로그램·암호 입력처럼 직접 상호작용이 필요한 경우 사람이 조작합니다. 이 기능은 터미널 출력·상태 공유이며 데스크톱 화면 캡처 공유는 아닙니다.

## 터미널 기본 조작

- 드래그 선택은 클립보드에 복사하고, 오른쪽 클릭은 바로 붙여넣습니다. Shift+오른쪽 클릭은 복사·붙여넣기 메뉴를 엽니다. 이 마우스 동작은 [PuTTY 기본 복사·붙여넣기](https://www.chiark.greenend.org.uk/~sgtatham/putty/faq.html)를 기준으로 합니다.
- Ctrl+V / Ctrl+Shift+V / Shift+Insert / macOS ⌘V와 상단 붙여넣기 버튼을 지원합니다. 한 줄은 Enter 없이 입력되며 여러 줄·제어 문자는 확인 후 붙여넣습니다.
- 선택 영역이 있으면 Ctrl+C / Ctrl+Insert / ⌘C로 복사합니다. 선택 영역이 없을 때 Ctrl+C는 원격 프로그램의 중단 키입니다.
- `Review & run`은 전체 명령을 확인하고 승인하면 실행합니다. `php -v`, `php-fpm8.5 -v`, 설치 명령 등을 명령 이름 때문에 차단하지 않습니다. 대화형 설치나 편집기는 `터미널에 넣기`를 사용해 직접 입력합니다.
- A−/A+ 또는 Ctrl/⌘ +/−/0으로 글자 크기를 조절하고, 설정에서 글자 크기와 스크롤 기록 줄 수를 저장합니다. `화면 지우기`는 서버 명령 없이 현재 터미널 표시만 정리합니다.
- 프로필 저장·그룹·검색·재접속·개인 키 인증·창 크기 변경·한글과 터미널 제어 키를 지원합니다. SSH 이외의 Telnet/시리얼과 포트 포워딩·프록시·에이전트는 이 개발 버전의 구현 범위에 포함되지 않습니다.

## 검증

```sh
npm test
npm run check
npm run build
npm run test:desktop
npm audit
```

Linux의 GUI 없는 환경에서 데스크톱 테스트는 `xvfb-run -a npm run test:desktop`으로 실행합니다. 테스트 전용 로그인 대체물은 개발 소스 실행에서만 사용할 수 있고 설치 패키지에 포함하지 않습니다. 자동 테스트는 실제 사용자 계정 동의·추론과 OS 서명 검증을 대신하지 않습니다.

## 빌드와 GitHub 배포

```sh
npm run package:dev
```

현재 OS의 개발 패키지를 만듭니다. GitHub Actions의 Desktop build verification으로 Windows·macOS 개발 패키지를 검증할 수 있습니다. 개발 패키지는 자동 업데이트를 설치하지 않습니다.

출시 순서는 다음과 같습니다.

1. 저장소의 `signed-release` 환경에 플랫폼별 인증서와 Apple 공증 자격 증명을 설정합니다.
2. Signed release candidates 워크플로를 실행해 서명된 설치 파일과 업데이트 메타데이터를 생성·검증합니다.
3. 실제 Windows·macOS 설치·연결·업데이트를 확인합니다.
4. 검증한 동일 커밋의 후보 실행 ID와 버전 태그로 Publish verified signed candidates를 수동 실행합니다.

배포 저장소는 GitHub Actions의 `GITHUB_REPOSITORY` 또는 명시한 `KEYSHELL_RELEASE_REPOSITORY`에서 결정합니다. 서명 필수 출시 경로는 필수 설정이 없으면 실패합니다. 서명 자격 증명을 코드나 채팅에 붙여 넣지 말고 GitHub 환경의 Secrets에 설정합니다. 워크플로 환경에 필요한 검토자 정책을 설정한 뒤 배포합니다.

## 데이터와 실행 경계

- 전송 전 확인 ON에서는 질문·첨부·이전 대화가 포함된 전체 요청을 확인할 수 있습니다. OFF에서는 전송 동작을, 자동 조언에서는 별도의 세션별 동의를 공유 승인으로 사용합니다. 가림은 로컬에서 하며 모든 비밀을 탐지한다고 보장하지 않습니다.
- 일반 대화에는 SSH 실행 도구나 인증정보 접근 권한을 제공하지 않습니다. AI 권한 ON 상태에서는 채팅으로 요청한 목표에 대해 앱이 AI의 구조화된 명령 요청을 실행합니다. 터미널 출력과 AI 답변은 비신뢰 데이터로 처리합니다.
- 앱의 승인·위임 명령은 현재 화면의 SSH PTY를 사용하며, 사용자의 현재 경로·환경을 이어 사용합니다. 별도 실행 결과 패널로 분리하지 않습니다. 명령어 허용 목록은 사용하지 않습니다. 사용자가 전체 명령과 대상을 확인해 한 번 승인하거나 AI 권한 ON 상태에서 채팅으로 목표를 보내면 실행하며, 숨겨진 제어 문자·잘못된 입력·가려진 값(****)이 포함된 명령은 거부합니다. 삭제·권한 변경·외부 전송·복합 셸 구문은 주의 항목으로 표시합니다.
- 실패·연결 단절·앱 재시작으로 질문이나 명령을 자동 재전송하지 않습니다. 결과를 알 수 없을 때 성공으로 표시하지 않습니다.
- 대화·터미널 출력·실행 기록은 메모리에만 보관합니다. 외부 제공자에게 이미 전송된 내용의 보관·삭제 범위는 제공자 정책을 따릅니다.

## 라이선스

[MIT](LICENSE)

---

<a id="english"></a>

## English

KeyShell is an SSH desktop application for Windows, macOS, and Linux with ChatGPT alongside the terminal. Ask questions about selected output, receive advice from newly shared SSH output, review individual commands, or delegate an installation or configuration goal.

The application is under development. Test SSH servers are used to verify command execution, result analysis, cancellation, clipboard behavior, and desktop interactions. These tests do not establish successful installation on your server or replace verification with your own ChatGPT account. Development installers are not production Windows-signed or Apple-notarized; Mac development builds use ad-hoc signing.

### Install or run from source

Download installers from [GitHub Releases](https://github.com/dhkay/keyshell/releases):

- **Windows x64:** run the `.exe` installer; Windows 10 or later.
- **macOS:** choose the Intel `mac-x64.dmg` or Apple Silicon `mac-arm64.dmg`, then move the app to Applications; macOS 13 or later.
- **Linux x64:** install the `.deb` on Ubuntu/Debian, or grant executable permission to the `.AppImage` and run it.

To develop locally, use Node.js 22 or later:

```sh
npm ci
npm start
```

The first launch has no saved SSH connections or AI accounts. SSH works without signing in to ChatGPT. SSH passwords and private-key passphrases are not saved. Connection profiles and trusted host keys are stored locally.

ChatGPT sign-in uses the [open-source application registration flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). Confirm your account and permissions in the browser. Access and usage limits depend on that account. Remembering the login is optional; when OS-encrypted storage is unavailable, tokens remain in memory only.

### Chat and terminal sharing

The controls currently use Korean labels:

| Control | Meaning |
| --- | --- |
| **전송 전 확인** | Review before sending |
| **AI 터미널 공유** | AI terminal sharing and automatic advice |
| **AI 권한** | Allow AI to execute requested SSH tasks |
| **터미널에 넣기** | Insert the command into the terminal |
| **직접 조작** | Stop AI control and return terminal input to you |

- **Review before sending** defaults to OFF. Enter sends your question and explicitly attached output; Shift+Enter inserts a newline. Enter used to finish Korean IME composition does not send the message. Turn review ON to inspect, edit, or cancel the complete request before sending.
- Scroll up to keep your reading position while answers arrive. Press Enter in an empty chat input to jump to the bottom and follow new content.
- **AI terminal sharing** defaults to OFF and requires separate consent for the current SSH session, account, model, and sharing scope. It sends newly received terminal and execution output after you enable it. It does not capture screenshots or automatically read other sessions, keyboard input, or credential storage.
- Automatic advice collects up to 8KiB of recent output, waits for two seconds of inactivity or ten seconds of collection, and sends at least 60 seconds apart. There is no ten-request quota. Older AI context is trimmed to a recent 64KiB window with a notice; previous conversation content can also be included.
- Automatic sharing stops when disabled, when the tab, connection, account, model, or conversation changes, on request errors, or when the renderer restarts. These preferences and sharing consent apply only to the current app run. Information already transmitted cannot be recalled.
- Requests use local secret masking, which can miss sensitive information. Review the information you choose to share.

### Local masking before AI transmission

Masking is always enabled. Questions, attached logs, history, automatic SSH sharing, command results, and delegated goals/checkpoints pass through the same local filter before the HTTP request is built. The preview shows the masked payload actually sent. IPv4/IPv6, password/API-key labels, recognized provider keys, tokens/JWTs, cookies, private-key blocks, database URL passwords, and supported CLI secret flags become `****`. SSH passwords/passphrases also register keyed comparison hashes for matching unlabeled, JSON-escaped, and URL-encoded copies during this app run; the registry does not retain their plaintext.

A changed secret registry invalidates old previews and blocks queued requests before sending. Failed masking sends nothing. AI commands containing `****` pause for local input rather than restoring secrets or expanding shell wildcards. Your local SSH display, clipboard, connection profiles, and remote logs/history keep their original values; masking applies to the copy sent to AI. Remaining content still reaches the external provider. Unknown unlabelled, arbitrarily encoded, or truncated secrets can escape detection; domains, usernames, email addresses, file paths, and business data are not automatically all removed.

### Command review and result analysis

Use **Review & run**, inspect the complete command and SSH target, then choose **Approve & run once**. Commands such as `php -v`, `php-fpm8.5 -v`, and package installation commands are not blocked by an executable-name allowlist. Hidden control characters and malformed input are rejected; displayed risk notices do not guarantee safety.

Select **실행 결과를 AI에 보내고 다음 작업 제안 받기** (“Send the execution result to AI and suggest next steps”) to analyze the final command status, exit code, and recent output up to 16KiB. This works without automatic terminal sharing, including for commands with no output or with failed or uncertain results. Suggested follow-up commands require their own approval in normal mode. Cancelled or changed contexts do not continue sharing the result.

Approved commands run in the same interactive SSH PTY you use. Your current directory and environment are shared: a `cd` or `export` from either you or the AI remains available to subsequent commands. Command output, including merged stdout and stderr, is displayed in that terminal. For interactive installers and editors, use **터미널에 넣기** and work in the terminal directly. Inserting a single-line command does not press Enter.


### AI authority in the same chat

With **AI authority OFF**, the assistant answers questions and suggests commands without running them. Turn **AI authority ON** for a connected SSH session to use the same chat for ordinary questions and server work. Only a requested inspection, installation, or configuration task creates a task list and executes commands sequentially. Messages sent while a command is active are considered after that command ends. The authority stays ON in the same session until switched OFF; changing tab, account, model, or connection revokes the binding.

### Delegate an installation or configuration goal

AI authority uses Responses API function tools to create a plan, request one SSH command at a time, and read its confirmed exit status and locally redacted output before choosing the next step. It supports requested inspections, installations, updates, vulnerability checks, and security patches in the same chat. The app checks local execution state every three seconds without injecting polling commands into a busy terminal. Tasks cannot be skipped, and completion requires an observed result; a short final report appears in chat.



Connect to SSH, sign in to ChatGPT, select a model, and click **AI 권한 OFF** to enable AI authority in the same chat. Write the goal in the existing chat input and press Enter; there is no separate goal entry window. For example:

> Install nginx, PHP 8.5, and MariaDB, then verify their versions and service health.

Turning ON authorizes requested SSH work on the current server and shows one informational message. Ordinary questions receive ordinary answers; requests to inspect, install, or configure a server create an ordered task list and execute it one command at a time. Additional chat messages are considered after the active command finishes. Completion or a request for more information leaves AI authority ON in the same context. Turning OFF revokes it. Changing the SSH tab, account, model, or connection revokes the session binding. The AI is instructed to inspect the OS and existing configuration, analyze observed results, adjust its plan, and verify the requested outcome. Commands, results, and progress appear in the same chat and terminal.

- There is no arbitrary step-count, overall task-duration, or command-runtime cutoff. A task can continue beyond the former 30-step, 30-minute, and ten-minute command limits until completion or an explicit stopping condition.
- Delegated commands run with the connected SSH account's permissions and can install software or change server configuration without individual command approvals within the consented goal.
- **AI 권한 ON · 끄기** stops further steps and requests interruption with Ctrl+C in the shared terminal. Cancellation, tab/account/model/connection/conversation changes, and app restarts also stop further execution. Interruption does not guarantee remote termination; changes already applied are not automatically rolled back.
- Completion and missing information end the current task while keeping the mode ON; AI errors and uncertain execution results turn the mode OFF without automatic replay. A normal observed execution result is required before the app accepts a completion response. Routine authorized steps are planned automatically; credentials, interactive input, or further authority may require user involvement.
- Detected deletion, interactive commands, disk management, reboot, repository addition, and similar operations requiring further confirmation stop automatic execution for manual review. This is not a sandbox that can fully determine the effects or goal alignment of arbitrary shell commands. Output and AI responses remain untrusted data, and masking and risk detection are incomplete.
- External AI service access, network availability, and account usage limits still apply.

### One terminal for you and the AI

Reviewed and delegated commands use your existing SSH PTY. They are labelled `[AI]`; output and exit status appear in the same terminal, without a separate execution output panel. Directory and environment changes persist for both manual and AI commands. Commands may be recorded by the remote shell according to its history settings.

- A confirmed shell prompt is required before AI input. Partial input and running foreground programs block AI execution; idle output is not proof of completion.
- During AI execution, ordinary input and paste are blocked to avoid collisions. **직접 조작** (“Take control”) or Ctrl+C without a selection stops further AI steps and returns input control. An unconfirmed outcome is recorded as unknown.
- Typing or pasting while the AI is planning stops delegation. It does not automatically take control back afterward.
- Completion detection uses Bash/Zsh prompt hooks in the current shell process and does not modify remote startup files or install a server agent. When prompt integration cannot be confirmed, manual SSH remains available and AI execution is blocked.
- The PTY merges stdout and stderr. Interactive programs and password entry require human control. Sharing the terminal does not capture desktop screenshots.

### Terminal basics

- Drag to select and copy. Right-click to paste; Shift+right-click opens the copy/paste menu.
- Paste with Ctrl+V, Ctrl+Shift+V, Shift+Insert, macOS Command+V, or the toolbar button. Multiline text and control characters require confirmation before pasting; single-line text is inserted without Enter.
- With a selection, Ctrl+C, Ctrl+Insert, or Command+C copies it. Without a selection, Ctrl+C is sent to the remote program as an interrupt key.
- Use A−/A+ or Ctrl/Command +/−/0 to adjust font size. Settings save font size and scrollback length. Clearing the screen changes the local terminal display without executing a server command.
- Saved profiles, groups, search, reconnection, private-key authentication, resizing, and terminal control keys are supported. Full PuTTY parity is not implemented: Telnet, serial connections, port forwarding, proxies, and agent forwarding are outside the current development version's scope.

### Development checks and packaging

```sh
npm test
npm run check
npm run build
npm run test:desktop
npm audit
npm run package:dev
```

On a Linux host without a display, use `xvfb-run -a npm run test:desktop`. Login fixtures are available only in explicitly opted-in source test runs and are excluded from installers. Development packages do not install automatic updates.

For signed production releases, configure platform certificates and Apple notarization credentials in the repository's `signed-release` environment, run **Signed release candidates**, verify native installation, SSH connections, and updates, then run **Publish verified signed candidates** for that exact verified commit and candidate run. The repository is selected through `GITHUB_REPOSITORY` or `KEYSHELL_RELEASE_REPOSITORY`. Missing required signing configuration fails the signed-release path. Keep signing credentials in GitHub environment secrets.

### Data and execution boundaries

With AI authority OFF, chat cannot execute SSH commands. With AI authority ON for the current SSH context, the application executes structured AI command requests for user-requested server work. Stored credentials are never exposed to the model. Failed requests, lost connections, and app restarts do not automatically replay commands or questions. Unknown outcomes are not presented as successful executions.

Conversations, terminal output, and execution records remain in memory and are discarded when the app exits. Profiles, trusted host keys, and account registration metadata persist locally; remembered tokens use available OS encryption. Information sent to an external AI service is subject to that provider's retention and deletion policies.

### License

[MIT](LICENSE)

[Back to 한국어](#한국어)
