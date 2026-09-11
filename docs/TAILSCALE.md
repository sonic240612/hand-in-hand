# Tailscale로 같은 세션에 참여하기

현재 원격 접속 방식은 **Tailscale Serve의 사설 HTTPS 연결**이다. 호스트와 참여 기기 모두 Tailscale 설치·로그인이 필요하다. 별도 중계 서버 배포나 공유기 포트 개방을 하지 않고, 각 기기의 Tailscale 연결을 이용한다. 이 문서의 기능은 기존의 동일 Codex 세션 원본·참여자별 실행기 위에 연결 방식을 추가한 것이다.

## 호스트

1. Tailscale 앱을 설치하고 로그인한 뒤 연결한다.
2. hand-in-hand를 `npm start`로 실행하고 `http://127.0.0.1:4317`을 연다.
3. 상단의 **Tailscale 설정 → Tailscale 연결 켜기**를 누른다.
4. 처음 HTTPS를 사용할 때 설정 허용이 필요하면 화면에 나온 Tailscale 관리 링크를 열어 완료하고 다시 연결한다.
5. **Tailscale 연결됨**을 확인한다. 사설 주소는 `https://기기.네트워크.ts.net:8443` 형태다.
6. 참여자가 다른 Tailscale 네트워크에 있다면 [기기 관리](https://login.tailscale.com/admin/machines)에서 이 호스트 기기를 공유하고, 참여자가 공유 초대를 수락하도록 한다. 같은 네트워크라면 접근 정책에서 이 기기의 HTTPS 포트를 허용해야 한다.
7. hand-in-hand의 **초대하기**로 만든 사설 초대 링크를 참여자에게 보낸다.

**Tailscale 기기 공유 초대와 hand-in-hand 세션 초대는 각각 필요하다.** 세션 링크 하나가 Tailscale 접근 권한까지 발급하지 않는다. 기기 공유를 수락하기 전에는 세션 링크가 열리지 않을 수 있다. Tailscale 기기 공유는 호스트의 다른 서비스에도 영향을 줄 수 있으므로 해당 공유 정책에서 허용할 포트를 정한다.

시작할 때 자동으로 사설 연결을 켜려면 다음 명령을 사용한다.

```powershell
npm start -- --tailscale
```

기본 HTTPS 포트 8443을 다른 서비스가 사용 중이면 기존 서비스를 덮어쓰지 않는다. 다른 포트를 명시한다.

```powershell
npm start -- --tailscale --tailscale-port 9443
```

Tailscale 상태 확인 없이 로컬·LAN 모드만 사용할 때는 `--no-tailscale`을 지정한다. 상태 확인은 로그인을 대신하거나 Tailscale 네트워크 전체 설정을 바꾸지 않는다.

## 참여자

1. 자신의 PC에 Tailscale을 설치하고 본인 계정으로 로그인한다.
2. 필요한 경우 호스트가 보낸 **Tailscale 기기 공유 초대**를 수락한다.
3. **hand-in-hand 세션 초대 링크**를 열고 이름을 입력한다.
4. 본인의 공식 Codex에 로그인한 뒤 화면의 **내 Codex 연결**을 누른다.
5. hand-in-hand 연결 프로그램에서 화면의 사설 주소와 연결 코드를 사용한다.

```powershell
npm run agent -- --host https://기기.네트워크.ts.net:8443
```

브라우저와 실행기 모두 같은 사설 주소를 사용한다. 초대 링크는 24시간·1회, 실행기 연결 코드는 10분·1회 사용이다. 이후 자기 지시는 자신의 실행기로 배정된다. 세션 데이터는 호스트가 보관한 같은 원본을 적용한다.

## 권한과 연결 종료

- Tailscale로 연결된 기기라도 hand-in-hand 참여 권한 없이 대화·파일을 볼 수 없다.
- Serve가 전달하는 개인 사용자 식별 헤더가 없는 요청은 거절한다. 인터넷 공개용 Funnel과 태그만 부여된 기기는 이 모드에서 지원하지 않는다.
- Tailscale 전용 수신기는 loopback에만 열고, 모든 요청을 원격 요청으로 취급한다. 원격 요청으로 호스트 소유자 자동 로그인이나 호스트 Codex 연결·Tailscale 설정 변경을 할 수 없다.
- 앱은 선택한 포트에만 Serve를 설정한다. 다른 서비스나 공개 Funnel 설정과 충돌하면 멈춘다. 네트워크 전체 `serve reset`은 실행하지 않는다.
- **사설 연결 끄기**는 이 앱이 설정한 주소만 해제한다. 정상 종료 시에도 해제한다. 강제 종료 후 Serve 등록이 남으면 앱이 기록한 소유 정보를 대조하여 재시작 시 대상 포트를 갱신한다. 다른 앱이 설정을 바꾼 경우 임의로 삭제하지 않는다.
- 세션 참여 권한을 회수하면 해당 참여자의 후속 데이터 접근을 막는다. Tailscale 기기 공유 자체는 Tailscale 관리 화면에서 별도로 회수한다.

## 문제 해결

| 화면 상태 | 조치 |
| --- | --- |
| Tailscale 설치 필요 | 공식 Tailscale을 설치한 뒤 상태 다시 확인 |
| 로그인·연결 필요 | Tailscale 앱에서 로그인하고 연결 켜기 |
| Windows 서비스 접근 권한 없음 | 해당 Windows 사용자의 Tailscale 제어 권한 확인 |
| HTTPS 사용 허용 필요 | 화면에 표시된 공식 관리 링크에서 허용 후 재시도 |
| 다른 서비스가 포트 사용 중 | `--tailscale-port`로 다른 HTTPS 포트 지정 |
| 초대 링크가 안 열림 | 참여자의 Tailscale 연결·기기 공유 수락·포트 접근 정책 확인 |

자동 테스트는 CLI 응답을 통제한 상태에서 HTTP 경계·설정 충돌·초대 URL·참여 권한을 검증한다. 실제 설치된 Tailscale의 상태 및 HTTPS 접속 확인 결과는 [검증 기록](PROTOTYPE-VALIDATION.md)에 별도로 적는다. 실제 다른 기기의 기기 공유 수락과 서로 다른 AI 계정의 사용량 분리까지 자동으로 검증한 것은 아니다.

출처: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Serve 명령](https://tailscale.com/docs/reference/tailscale-cli/serve), [기기 공유](https://tailscale.com/docs/features/sharing).
