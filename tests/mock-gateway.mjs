import { createServer } from 'node:http';

/**
 * A stand-in for OmniRoute, so the test suite never touches the network.
 * It answers by looking for the marker sentences in each prompt.
 */
const REPLY = (obj) => ({
  id: 'mock',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(obj) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
});

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text || '').join(' ');
  return '';
}

function decide(body, screen = 'quiz') {
  const messages = body.messages || [];
  const all = messages.map((m) => textOf(m.content)).join('\n');
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
  const haystack = `${system}\n${all}`;

  if (haystack.includes('looking at a screenshot')) {
    if (screen === 'lecture') {
      return REPLY({
        screen_type: 'lecture',
        topic: 'chloroplast structure',
        visible_text: 'Thylakoid membrane: light reactions. Stroma: Calvin cycle.',
        question: null,
        word_target: null,
        confidence: 0.9,
      });
    }
    if (screen === 'essay_prompt') {
      return REPLY({
        screen_type: 'essay_prompt',
        topic: 'photosynthesis essay',
        visible_text: 'In 300 words, argue whether photosynthesis is better described as nutrition or as energy conversion.',
        question: null,
        word_target: 300,
        confidence: 0.9,
      });
    }
    return REPLY({
      screen_type: 'quiz',
      topic: 'photosynthesis',
      visible_text:
        'Which organelle performs photosynthesis in plant cells?\nA) Mitochondria\nB) Chloroplast\nC) Ribosome\nD) Golgi',
      question: {
        stem: 'Which organelle performs photosynthesis in plant cells?',
        kind: 'mcq',
        options: ['A) Mitochondria', 'B) Chloroplast', 'C) Ribosome', 'D) Golgi'],
        lettering: 'A',
      },
      word_target: null,
      confidence: 0.92,
    });
  }
  if (haystack.includes('is being asked this question in')) {
    return REPLY({
      chosen_index: 1,
      answer_text: 'B) Chloroplast',
      work: 'Chloroplasts carry chlorophyll and the thylakoid membranes where the light reactions run.',
      evidence: 'mixed',
      confidence: 0.88,
      needs_human: false,
    });
  }
  if (haystack.includes('Write the essay this prompt asks for')) {
    return REPLY({
      title: 'Light as Work',
      thesis: 'Photosynthesis is better understood as a machine for doing work than as a way of "making food".',
      prose:
        'Photosynthesis looks like a feeding process and behaves like an engineering one.\n\n' +
        'The lecture put the light reactions in the thylakoid membrane and the Calvin cycle in the stroma, ' +
        'which is really a description of an assembly line split across two rooms.\n\n' +
        'If that is right, the interesting question is not how plants eat but how they budget energy.',
      word_count: 68,
      citations: ['light reactions occur in the thylakoid membrane', 'Calvin cycle occurs in the stroma'],
      confidence: 0.7,
    });
  }
  if (haystack.includes('You just saw this screen')) {
    return REPLY({
      topic: 'chloroplast structure',
      summary: 'Chloroplasts contain stacked thylakoids where the light reactions happen, suspended in stroma where carbon is fixed.',
      facts: [
        { claim: 'Light reactions occur in the thylakoid membrane', kind: 'process' },
        { claim: 'The Calvin cycle occurs in the stroma', kind: 'process' },
      ],
      key_terms: ['thylakoid', 'stroma', 'chlorophyll'],
      confident: true,
    });
  }
  if (haystack.includes('Build a study pack')) {
    return REPLY({
      summary: 'The lecture covered chloroplast structure and split photosynthesis into two stages.',
      key_terms: [
        { term: 'thylakoid', meaning: 'the membrane stack where the light reactions run' },
        { term: 'stroma', meaning: 'the fluid where carbon is fixed' },
      ],
      flashcards: [
        { front: 'Where do the light reactions happen?', back: 'In the thylakoid membrane.' },
        { front: 'Where does the Calvin cycle happen?', back: 'In the stroma.' },
      ],
      likely_exam: ['Compare the inputs and outputs of the two stages.'],
      gaps: ['The lecture never defined photorespiration.'],
    });
  }
  if (haystack.includes('Human corrections (agreed')) {
    return REPLY({
      lessons: [
        { scope: 'quiz', text: 'When a multiple-choice option restates the slide wording, prefer it over a paraphrase.' },
        { scope: 'global', text: 'State the reasoning before the answer so a human can catch a wrong step.' },
      ],
      drift: { hedging: -0.05, boldness: 0.05 },
      assessment: 'Solid on recall, weaker when the question inverts the definition.',
    });
  }
  if (haystack.includes('You are being asked about a course')) {
    return REPLY({ answer: 'The lecture spent the most time on the thylakoid/stroma split, so expect that.' });
  }
  return REPLY({ answer: 'ok' });
}

export async function startMockGateway() {
  let transcript = 'Photosynthesis converts light energy into chemical energy.';
  let screen = 'quiz';

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');

      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'auto' }] }));
      }
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ text: transcript }));
      }
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        const result = decide(body, screen);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      res.writeHead(404).end('{}');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    setTranscript: (t) => { transcript = t; },
    setScreen: (s) => { screen = s; },
    close: () => new Promise((r) => server.close(r)),
  };
}
