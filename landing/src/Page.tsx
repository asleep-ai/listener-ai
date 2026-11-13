// The Listener.AI landing page, rendered to static HTML at build time.
//
// Every interactive element is native HTML (anchors, <details>, <video>), so
// the page needs no client-side React. Astryx components supply typography,
// buttons and links; `docs/assets/downloads.js` progressively enhances the
// download links after load.
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

import { DOWNLOAD_PLATFORMS, RELEASE_PAGE_URL, REPOSITORY_URL } from './site.js';

function Brand() {
  return (
    <a className="brand" href="./" aria-label="Listener.AI 홈">
      <span className="brand-mark" aria-hidden="true">
        L
      </span>
      Listener<span className="brand-ai">.AI</span>
    </a>
  );
}

function Header() {
  return (
    <header className="site-header shell">
      <Brand />
      <nav aria-label="주요 메뉴" className="site-nav">
        <Link href="#workflow" type="inherit" color="inherit">
          기능
        </Link>
        <Link href="#demo" type="inherit" color="inherit">
          데모
        </Link>
        <Link href="#questions" type="inherit" color="inherit">
          자주 묻는 질문
        </Link>
      </nav>
      <Button label="다운로드" href="#download" variant="secondary" size="sm" />
    </header>
  );
}

function Hero() {
  return (
    <section className="hero shell" aria-labelledby="hero-title">
      <div className="hero-copy">
        <Text as="p" display="block" type="label" color="secondary" className="intro">
          내 컴퓨터에 남는 AI 회의 노트
        </Text>
        <Heading level={1} type="display-1" id="hero-title" className="hero-title">
          대화가 끝나면,
          <br />
          다음 할 일이
          <br />
          보이도록.
        </Heading>
        <Text as="p" display="block" type="large" color="secondary" className="hero-description">
          회의에서는 대화에 집중하세요.
          <br />
          Listener.AI가 녹음한 대화를 읽을 수 있는 기록과
          <br className="desktop-break" /> 실행할 수 있는 할 일로 정리합니다.
        </Text>
        <div className="hero-actions">
          <Button label="Listener.AI 다운로드" href="#download" variant="primary" size="lg" />
          <Button label="실제 앱 데모 보기" href="#demo" variant="secondary" size="lg" />
        </div>
        <Text as="p" display="block" type="supporting" color="secondary" className="hero-meta">
          macOS · Windows / 오픈 소스 / 내 AI 계정 연결
        </Text>
      </div>
      <ConversationExample />
    </section>
  );
}

function ConversationExample() {
  return (
    <div className="conversation" role="group" aria-label="대화가 회의 노트로 정리되는 과정의 설명용 예시">
      <div className="conversation-top">
        <Text type="supporting" color="secondary">
          이렇게 정리해요
        </Text>
        <Text type="supporting" color="secondary">
          설명용 예시
        </Text>
      </div>
      <div className="transcript-example">
        {[
          ['참가자 1', '온보딩은 금요일까지 수정하면 어떨까요?'],
          ['참가자 2', '좋아요. 제가 첫 화면 문구를 정리할게요.'],
          ['참가자 1', '그럼 다음 회의에서 같이 확인하죠.'],
        ].map(([speaker, line]) => (
          <p key={line}>
            <span className="speaker">{speaker}</span>
            {line}
          </p>
        ))}
      </div>
      <div className="note-connector" aria-hidden="true">
        <span />
        대화에서 결정으로
        <span />
      </div>
      <div className="note-example">
        <Text as="p" display="block" type="large" weight="semibold" className="note-title">
          온보딩 개선 회의
        </Text>
        <Text as="p" display="block" type="label" color="secondary" className="note-heading">
          결정한 내용
        </Text>
        <Text as="p" display="block" type="body">
          첫 화면 문구를 수정하고 다음 회의에서 검토합니다.
        </Text>
        <Text as="p" display="block" type="label" color="secondary" className="note-heading">
          다음 할 일
        </Text>
        <div className="task-example">
          <span className="task-check" aria-hidden="true" />
          <Text type="body">첫 화면 문구 정리</Text>
          <span className="task-owner">참가자 2</span>
        </div>
        <Text as="p" display="block" type="supporting" color="secondary" className="example-footnote">
          예시 대화와 요약입니다. 실제 앱 화면은 아래 데모에서 확인하세요.
        </Text>
      </div>
    </div>
  );
}

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Heading level={2} type="display-2" id={id} className="section-title">
      {children}
    </Heading>
  );
}

function Demo() {
  return (
    <section className="demo-section shell" id="demo" aria-labelledby="demo-title">
      <div className="section-heading">
        <div>
          <Text as="p" display="block" type="label" color="secondary" className="intro">
            직접 보고 시작하세요
          </Text>
          <SectionTitle id="demo-title">
            오디오 하나가
            <br />
            회의 노트가 되기까지.
          </SectionTitle>
        </div>
        <Text as="p" display="block" type="body" color="secondary">
          샘플 음원을 실제 앱에서 처리한 데모입니다.
          <br />
          대화록과 요약을 확인하는 흐름을 살펴보세요.
        </Text>
      </div>
      <figure className="demo-frame">
        <video
          controls
          playsInline
          preload="none"
          poster="assets/demos/listener-demo.jpg"
          aria-label="Listener.AI 실제 앱 데모"
          aria-describedby="demo-caption"
        >
          <source src="assets/demos/listener-demo.mp4" type="video/mp4" />
          <track kind="captions" src="assets/demos/listener-demo.ko.vtt" srcLang="ko" label="한국어" default />
          브라우저가 동영상 재생을 지원하지 않습니다. <a href="assets/demos/listener-demo.mp4">데모 영상 다운로드</a>
        </video>
        <figcaption id="demo-caption">
          <Text type="supporting" color="secondary">
            실제 앱 · 샘플 음원 사용
          </Text>
          <Link href="#demo-description" type="supporting">
            영상의 텍스트 설명 읽기
          </Link>
        </figcaption>
      </figure>
      <details className="demo-description" id="demo-description">
        <summary>영상의 텍스트 설명</summary>
        <Text as="p" display="block" type="body" color="secondary">
          Listener.AI에 샘플 대화 음원을 불러와 AI 처리를 실행합니다. 처리가 끝나면 저장된 회의를 열어 회의 요약과
          발화자별 대화록을 확인하고, 이 회의에서 무엇을 설계하는지 질문합니다. 실제 답변은 리모컨을 설계하는 팀이며
          구체적인 요구사항은 아직 논의하지 않았다는 내용입니다. 영상은 소리 없이 재생되며 처리 대기 시간을 줄이고 실제
          화면 일부를 정지 화면으로 보여줍니다.
        </Text>
      </details>
      <Text as="p" display="block" type="supporting" color="secondary" className="demo-credit">
        샘플:{' '}
        <Link href="https://groups.inf.ed.ac.uk/ami/download/" type="inherit">
          AMI Meeting Corpus
        </Link>
        , AMI Consortium, ES2002a 02:00–04:00 구간.{' '}
        <Link href="https://creativecommons.org/licenses/by/4.0/" type="inherit">
          CC BY 4.0
        </Link>
        . 원본 음원을 전사·요약한 결과를 실제 앱에서 촬영하고 편집했습니다.
      </Text>
    </section>
  );
}

const WORKFLOW_STEPS = [
  {
    title: '녹음하거나 오디오를 불러오세요',
    body: '회의를 녹음하고, 이미 있는 음성 파일도 처리하세요. macOS에서는 시스템 오디오를 함께 녹음해 온라인 회의의 상대방 목소리도 담을 수 있습니다.',
    moment: '회의의 시작',
  },
  {
    title: '대화록에서 다음 할 일까지',
    body: '발화자를 구분한 대화록, 안건별 요약, 핵심 내용과 담당자별 할 일을 확인하세요. 회의에서 사용한 언어로 정리합니다.',
    moment: '회의가 끝난 뒤',
  },
  {
    title: '기억이 흐려지면, 기록에 물어보세요',
    body: '저장된 회의를 검색하거나 AI 채팅으로 질문하세요. 지난 회의의 결정과 맥락을 다시 찾아 다음 대화를 준비할 수 있습니다.',
    moment: '다음 회의 전에',
  },
];

function Workflow() {
  return (
    <section className="workflow-section shell" id="workflow" aria-labelledby="workflow-title">
      <div className="section-heading">
        <SectionTitle id="workflow-title">
          기록하고, 정리하고,
          <br />
          필요할 때 다시 꺼내세요.
        </SectionTitle>
        <Text as="p" display="block" type="body" color="secondary">
          회의가 끝난 뒤 흩어진 메모를 맞추는 대신,
          <br />
          하나의 기록에서 이어가세요.
        </Text>
      </div>
      {/* The three steps follow one meeting from start to the next meeting, so they are an ordered list. */}
      <ol className="workflow-list">
        {WORKFLOW_STEPS.map((step, index) => (
          <li key={step.title}>
            <span className="step-number" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <Heading level={3}>{step.title}</Heading>
              <Text as="p" display="block" type="body" color="secondary">
                {step.body}
              </Text>
            </div>
            <Text as="p" display="block" type="supporting" color="secondary" className="feature-tag">
              {step.moment}
            </Text>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Ownership() {
  return (
    <section className="ownership-section" aria-labelledby="ownership-title">
      <div className="shell ownership-grid">
        <div>
          <Text as="p" display="block" type="label" color="secondary" className="intro">
            기록의 중심은 나에게
          </Text>
          <SectionTitle id="ownership-title">
            내 컴퓨터에 보관하고,
            <br />
            내가 고른 AI로.
          </SectionTitle>
          <Text as="p" display="block" type="body" color="secondary" className="ownership-lead">
            녹음과 회의 기록은 로컬에 저장합니다.
            <br />
            AI 처리는 연결한 제공자에게 요청하므로,
            <br />
            사용할 서비스와 공유할 내용을 직접 선택하세요.
          </Text>
          <Link href="privacy/" className="ownership-link">
            개인정보 처리방침 읽기
          </Link>
        </div>
        <div className="ownership-notes">
          <article>
            <Heading level={3}>가지고 있는 AI 계정 연결</Heading>
            <Text as="p" display="block" type="body" color="secondary">
              Gemini, OpenAI, Soniox 등 지원하는 서비스의 API 키를 연결하세요. ChatGPT 로그인은 요약과 AI 채팅 같은
              텍스트 작업에 사용할 수 있습니다.
            </Text>
            <Text as="p" display="block" type="supporting" color="secondary" className="billing-note">
              음성 전사와 실시간 자막에는 별도 제공자 설정이 필요하며, API 사용 요금은 해당 제공자에서 발생할 수
              있습니다. ChatGPT 로그인에 음성 처리가 포함되지는 않습니다.
            </Text>
          </article>
          <article>
            <Heading level={3}>팀이 쓰는 도구로 이어서</Heading>
            <Text as="p" display="block" type="body" color="secondary">
              설정한 Notion과 Slack으로 회의 노트를 보내세요. Google Drive를 연결하면 회의 폴더를 동기화할 수 있습니다.
              연동은 선택 사항입니다.
            </Text>
          </article>
        </div>
      </div>
    </section>
  );
}

const QUESTIONS = [
  {
    question: '앱을 사용하려면 무엇이 필요한가요?',
    answer:
      'macOS 또는 Windows 컴퓨터와 AI 제공자 연결이 필요합니다. 앱 설치 후 설정에서 요약에 사용할 AI와 음성 전사 제공자를 선택하세요. 서비스에 따라 API 키 또는 ChatGPT 로그인이 필요합니다.',
  },
  {
    question: '오프라인에서도 AI 처리가 되나요?',
    answer:
      '녹음과 기록 보관은 내 컴퓨터에서 이루어집니다. AI 전사, 요약, 채팅에는 인터넷 연결이 필요하며 오디오나 텍스트가 선택한 제공자에게 전송됩니다. 로컬 저장이 로컬 AI 처리를 의미하지는 않습니다.',
  },
  {
    question: '별도 구독이 필요한가요?',
    answer:
      'Listener.AI는 오픈 소스로 제공됩니다. 연결한 AI 서비스의 API 이용료와 계정 조건은 각 제공자의 정책을 따릅니다. ChatGPT 로그인을 사용해도 음성 전사 제공자의 API 비용은 별도로 발생할 수 있습니다.',
  },
  {
    question: '내 기록을 다른 곳으로 보낼 수 있나요?',
    answer:
      '회의 노트는 로컬에 보관하며 내보내기와 검색을 지원합니다. Notion, Slack, Google Drive를 연결한 경우 해당 서비스로 기록을 전송할 수 있습니다. 회의 참여자의 동의를 확인하고 필요한 내용만 공유하세요.',
  },
];

function Questions() {
  return (
    <section className="questions-section shell" id="questions" aria-labelledby="questions-title">
      <SectionTitle id="questions-title">시작하기 전에.</SectionTitle>
      <div className="questions-list">
        {QUESTIONS.map(({ question, answer }) => (
          <details key={question}>
            <summary>{question}</summary>
            <Text as="p" display="block" type="body" color="secondary">
              {answer}
            </Text>
          </details>
        ))}
      </div>
    </section>
  );
}

// Download links stay native anchors: each one carries two lines of content
// that `downloads.js` rewrites in place (href, detail text and icon). Astryx
// Button fixes an `aria-label` when given children and has a single-line
// height, and ClickableCard renders its content outside the anchor, so both
// would leave a stale accessible name after enhancement.
function Download() {
  return (
    <section className="download-section shell" id="download" aria-labelledby="download-title">
      <div>
        <Text as="p" display="block" type="label" color="secondary" className="intro">
          다음 회의부터 가볍게
        </Text>
        <SectionTitle id="download-title">
          좋은 대화는 남기고,
          <br />
          정리는 맡기세요.
        </SectionTitle>
        <Text as="p" display="block" type="body" color="secondary" className="download-lead">
          운영체제에 맞는 최신 설치 파일을
          <br />
          GitHub Releases에서 받으세요.
        </Text>
      </div>
      <div className="download-options">
        {DOWNLOAD_PLATFORMS.map((platform) => (
          <a key={platform.id} className="download-option" data-download-platform={platform.id} href={RELEASE_PAGE_URL}>
            <span>
              <strong>{platform.name}</strong>
              <span data-download-detail="">{platform.fallbackDetail}</span>
            </span>
            <span aria-hidden="true" data-download-icon="">
              ↗
            </span>
          </a>
        ))}
        <Text
          as="p"
          display="block"
          type="supporting"
          color="secondary"
          className="download-status"
          data-download-status=""
        >
          각 링크는 GitHub의 최신 릴리스 페이지를 엽니다. 운영체제에 맞는 설치 파일을 선택하세요.
        </Text>
        <Text as="p" display="block" type="supporting" color="secondary">
          Mac의 칩 종류는 Apple 메뉴 &gt; 이 Mac에 관하여에서 확인할 수 있습니다.
          <br />
          개발자라면{' '}
          <Link href={REPOSITORY_URL} type="inherit">
            소스 코드와 CLI 안내
          </Link>
          를 확인하세요.
        </Text>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer shell">
      <a className="brand brand-small" href="./">
        Listener<span className="brand-ai">.AI</span>
      </a>
      <Text as="p" display="block" type="supporting" color="secondary">
        대화에 집중할 수 있도록.
      </Text>
      <nav aria-label="법적 정보 및 소스" className="footer-nav">
        <Link href="privacy/" type="supporting" color="secondary">
          개인정보 처리방침
        </Link>
        <Link href="terms/" type="supporting" color="secondary">
          이용약관
        </Link>
        <Link href={REPOSITORY_URL} type="supporting" color="secondary">
          GitHub
        </Link>
      </nav>
    </footer>
  );
}

export function Page() {
  return (
    <Theme theme={neutralTheme} mode="light">
      <a className="skip-link" href="#main">
        본문으로 건너뛰기
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        <Hero />
        <Demo />
        <Workflow />
        <Ownership />
        <Questions />
        <Download />
      </main>
      <Footer />
    </Theme>
  );
}
