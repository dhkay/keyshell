# KeyShell

Windows와 macOS용 SSH 데스크톱 앱입니다. 터미널과 AI 대화를 나누고, 사용자가 확인한 출력만 ChatGPT에 공유합니다. 제안된 명령은 전체 내용과 접속 대상을 확인한 뒤 한 번 실행합니다.

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

- 공유 전 질문·첨부·이전 대화가 포함된 전체 요청을 확인할 수 있습니다. 가림은 로컬에서 하며 모든 비밀을 탐지한다고 보장하지 않습니다.
- AI에는 SSH 실행 도구나 인증정보 접근 권한을 제공하지 않습니다. 터미널 출력과 AI 답변은 비신뢰 데이터로 처리합니다.
- 앱의 명령 실행은 별도 SSH exec 채널을 사용하며, 대화형 셸의 디렉터리·환경을 상속하지 않습니다. 해석할 수 없는 실행 구조와 전송은 차단합니다.
- 실패·연결 단절·앱 재시작으로 질문이나 명령을 자동 재전송하지 않습니다. 결과를 알 수 없을 때 성공으로 표시하지 않습니다.
- 대화·터미널 출력·실행 기록은 메모리에만 보관합니다. 외부 제공자에게 이미 전송된 내용의 보관·삭제 범위는 제공자 정책을 따릅니다.

## 라이선스

[MIT](LICENSE)
