/** A synthetic conversation payload shaped like the real share API response. */
const t = Math.floor(Date.parse('2026-03-14T09:26:53Z') / 1000);

const node = (id, parent, role, content, extra = {}) => ({
  id,
  parent,
  children: [],
  message: {
    id,
    author: { role },
    create_time: t + Number(id.slice(1)) * 60,
    content,
    metadata: { model_slug: role === 'assistant' ? 'gpt-5' : undefined },
    recipient: 'all',
    ...extra,
  },
});

const text = (...parts) => ({ content_type: 'text', parts });

export const payload = {
  title: 'Rendering test: math, code, tables',
  create_time: t,
  default_model_slug: 'gpt-5',
  linear_conversation: [
    node('n0', null, 'system', text('You are a helpful assistant.')),
    node('n1', 'n0', 'user', text('Explain the quadratic formula and show a Python solver.')),
    node(
      'n2',
      'n1',
      'assistant',
      text(
        [
          'The roots of \\(ax^2 + bx + c = 0\\) are given by:',
          '',
          '\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]',
          '',
          'The discriminant $b^2 - 4ac$ decides the shape of the answer:',
          '',
          '| Discriminant | Roots |',
          '| --- | --- |',
          '| $> 0$ | two real |',
          '| $= 0$ | one repeated |',
          '| $< 0$ | complex pair |',
          '',
          '### A solver',
          '',
          '```python',
          'import cmath',
          '',
          'def solve(a: float, b: float, c: float):',
          '    """Return both roots, real or complex."""',
          '    d = b**2 - 4*a*c  # not math: $b^2$ stays literal here',
          '    return ((-b + cmath.sqrt(d)) / (2*a), (-b - cmath.sqrt(d)) / (2*a))',
          '```',
          '',
          'Notes:',
          '',
          '1. Use `cmath` so negative discriminants still work.',
          '2. Guard against `a == 0` — that is a *linear* equation.',
          '3. See [the docs](https://docs.python.org/3/library/cmath.html) for details.',
          '',
          '> Floating point subtraction can cancel catastrophically when $b^2 \\gg 4ac$.',
        ].join('\n'),
      ),
    ),
    node('n3', 'n2', 'user', {
      content_type: 'multimodal_text',
      parts: [
        { content_type: 'image_asset_pointer', width: 1024, height: 768 },
        'What does this plot say about the roots?',
      ],
    }),
    node('n4', 'n3', 'assistant', {
      content_type: 'thoughts',
      thoughts: [{ summary: 'Reading the plot', content: 'The parabola crosses the x-axis twice.' }],
    }),
    node('n5', 'n4', 'assistant', { content_type: 'code', language: 'python', text: 'plt.plot(xs, ys)' }, { recipient: 'python' }),
    node('n6', 'n5', 'tool', { content_type: 'execution_output', text: '<Figure size 640x480>' }),
    node('n7', 'n6', 'assistant', text('Two real roots — the curve crosses the axis twice.')),
    node('n8', 'n7', 'assistant', text('hidden housekeeping'), {
      metadata: { is_visually_hidden_from_conversation: true },
    }),
  ],
};
