# STILLWATER Classical BaZi Knowledge Base v1

Status: research baseline — not yet wired into production reading
Branch: `feature/classical-bazi-kb-v1`

## Purpose

This document defines the first source-controlled knowledge layer for STILLWATER's BaZi reasoning engine. The objective is not to let an LLM invent BaZi interpretations. The objective is to convert classical source material into explicit, reviewable reasoning rules that can later be executed deterministically and passed to Vera as evidence.

This is a traditional divination framework, not a scientific diagnostic or predictive system. The engine must not present classical claims as scientifically established facts.

## Source hierarchy

### Tier A — primary classical texts

1. **《渊海子平》 Yuan Hai Zi Ping**
   - Foundation for the later Zi Ping four-pillar tradition.
   - Use for: ten stems/twelve branches, five-element relationships, ten gods, basic pattern language, traditional interpretive formulas.

2. **《三命通会》 San Ming Tong Hui — 万民英, Ming**
   - Large compendium of Zi Ping material and related traditional methods.
   - Use for: five-element theory, ten-god/pattern discussions, luck-period reasoning, traditional combinations and auxiliary methods.
   - Important source note: its own opening discussion explicitly describes later changes in the transmission of Zi Ping methods; therefore the engine must not pretend every rule in every later text is one unchanged historical system. [Source: Wikisource / Chinese Text Project]

3. **《滴天髓》 Di Tian Sui**
   - Use for: dynamic balance, strength/weakness, cold/warm, dry/wet, month command, body/use distinctions, and the principle that interpretation cannot be reduced to one variable.

4. **《子平真诠》 Zi Ping Zhen Quan — 沈孝瞻, Qing**
   - Use for: month-command framework, useful-god and pattern reasoning, pattern success/failure, supporting factor (相神), and luck-period interpretation.
   - Original text and later commentaries must be stored separately. Later commentary is not automatically treated as the author's rule.

5. **《穷通宝鉴》 Qiong Tong Bao Jian / 《栏江网》 tradition**
   - Use for: seasonal climate adjustment (调候), especially the interaction of Day Master, month/season, temperature, moisture and required elements.
   - This source is particularly valuable for avoiding simplistic "element count" readings.

### Tier B — supplementary classical material

6. **《神峰通考》 Shen Feng Tong Kao**
   - Use for additional pattern, disease/remedy (病药), ten-god, family and luck-period examples.

7. **《滴天髓阐微》 Di Tian Sui Chan Wei — 任铁樵 commentary**
   - Use as a later explanatory layer, never silently merged with the original 《滴天髓》.

8. **《五行精纪》 and related early material**
   - Candidate source for cross-checking older five-element and life-pattern rules.

## Core principles extracted for the engine

### Rule family A — the chart is relational, not a single-element lookup

The classical material repeatedly treats a chart as a relationship among seasonal qi, Day Master, other stems/branches, and subsequent movement. Therefore the engine must not implement rules such as `wood = growth` as complete readings.

Minimum evidence required before producing a strong conclusion:
- Day Master
- month/season
- visible and hidden elements
- relevant ten-god relationships
- major structural interactions
- relevant year/luck-period interaction

### Rule family B — month command is a primary anchor

《滴天髓》 describes the month command as the key structural reference point. 《子平真诠》 is likewise organized around using the month command as the starting point for useful-god/pattern analysis.

Implementation consequence:
- calculate the month pillar using the project's explicit solar-term convention;
- identify the seasonal/month-command context before evaluating strength or useful factors;
- do not infer a useful element from raw element counts alone.

### Rule family C — strength/weakness is conditional

《滴天髓》 explicitly warns against a mechanical strong/weak rule. Strong conditions can contain weakness and weak conditions can contain strength; excessive supplementation or reduction can reverse the intended result.

Implementation consequence:
- `dayMasterStrength` is an evidence value, not the final answer;
- every strength conclusion must retain its supporting factors;
- avoid `strong => always reduce` and `weak => always increase` as unconditional rules.

### Rule family D — seasonal climate matters

《滴天髓》 discusses cold/warm and dry/wet conditions. 《穷通宝鉴》 develops this into detailed month-by-month treatment of individual stems.

Implementation consequence:
- create a separate `climateAdjustment` layer;
- evaluate season before applying a generic element preference;
- retain temperature/moisture evidence separately from strength evidence.

### Rule family E — useful factors must be justified

A useful factor (用神/喜忌 in the selected framework) cannot be reduced to the most deficient element. It must be derived from the selected pattern/season/structure and checked against competing conditions.

Implementation consequence:
```text
chart
→ month command
→ pattern candidates
→ structural success/failure
→ climate adjustment
→ candidate useful factors
→ conflict/exception checks
→ ranked useful factors
```

### Rule family F — luck/year is an interaction with the natal chart

《三命通会》 describes postnatal movement (运限) as changing the balance of the original chart and explicitly connects luck-period movement with the year's influence.

Implementation consequence:
- never label a year "good" or "bad" in isolation;
- calculate `natalChart × luckPeriod × annualPillar`;
- retain which pillar/structure is activated and why;
- only then map the result to the customer's question domain.

### Rule family G — the question determines which evidence matters

This is a STILLWATER product rule derived from the classical framework rather than a quotation from one text.

A chart can contain evidence relevant to work, money, relationships, family, study, movement, etc. The reading engine must first classify the customer's question and then rank relevant evidence.

Example:
- question: "Should I resign in 2026?"
- relevant evidence: career/authority, resource support, wealth pressure, movement/change indicators, annual interactions
- irrelevant evidence should not dominate the narrative simply because it exists in the chart.

## Classical source → engine mapping

| Source | Primary engine role | Do not overuse for |
|---|---|---|
| 渊海子平 | foundational Zi Ping vocabulary and structures | modern psychological personality labels |
| 三命通会 | broad cross-check, movement, traditional patterns | treating every auxiliary rule as equally authoritative |
| 滴天髓 | dynamic balance, climate, strength, month command | simple element-count scoring |
| 子平真诠 | month-command/pattern/useful-factor reasoning | silently replacing original text with later commentary |
| 穷通宝鉴 | seasonal climate / Tiao Hou | universal rules detached from month/season |
| 神峰通考 | supplementary patterns and case-style checks | overriding stronger core evidence without justification |
| 滴天髓阐微 | commentary and interpretive cross-check | representing commentary as original text |

## Evidence object design

Every substantive BaZi conclusion should eventually be representable as an object similar to:

```ts
interface BaziEvidence {
  statement: string;
  source: {
    work: string;
    section?: string;
    layer: 'original' | 'commentary' | 'stillwater-rule';
  };
  conditions: string[];
  observations: string[];
  exceptions?: string[];
  relevance: 'high' | 'medium' | 'low';
  confidence: number;
}
```

The important property is provenance: the system should be able to answer internally, "Why did we say this?"

## Annual reading object

```ts
interface AnnualBaziAnalysis {
  year: number;
  annualStem: string;
  annualBranch: string;
  natalInteractions: Array<{
    type: 'combine' | 'clash' | 'harm' | 'punishment' | 'break' | 'support' | 'other';
    target: string;
    significance: string;
  }>;
  usefulFactorImpact: string[];
  climateImpact: string[];
  questionRelevantEvidence: BaziEvidence[];
  overallDirection: 'supportive' | 'mixed' | 'challenging' | 'unclear';
}
```

## Tarot integration rule

Tarot is a second evidence layer, not a replacement for the natal/year analysis.

Required synthesis order:

```text
Birth data
→ Four Pillars
→ natal structure
→ target year
→ question classification
→ question-relevant BaZi evidence
→ tarot draw
→ locked tarot core meaning
→ synthesis
→ Vera answer
```

The LLM must not:
- calculate the Four Pillars itself;
- invent a new tarot card meaning;
- invent a classical rule;
- convert one favorable/unfavorable indicator into an absolute life prediction.

The LLM may:
- connect the evidence;
- explain conflicts between evidence layers;
- translate technical reasoning into natural language;
- identify the practical decision implied by the question.

## Example synthesis pattern

Question: "Should I leave my job in 2026?"

Do not produce:
> "2026 is a difficult year, so you should be careful. The Chariot means moving forward."

Preferred internal reasoning:

```text
1. Natal chart identifies the person's relevant career/authority structure.
2. 2026 annual pillar activates specific natal structures.
3. Determine whether the activation supports stability, restructuring, pressure, or movement.
4. Apply seasonal/useful-factor evidence and note conflicts.
5. Draw tarot: The Chariot.
6. Retrieve only the locked core meaning of The Chariot.
7. Synthesize: the year evidence says X; the tarot emphasizes Y; together they answer the resignation question as Z.
8. State what condition would make resignation sensible vs premature.
```

This is the product's answer-generation model: **evidence first, narrative second**.

## Source verification policy

1. Preserve original Chinese terminology where it carries technical meaning.
2. Store original-text excerpts separately from translations/paraphrases.
3. Never treat a modern website's interpretation as a primary classical rule without labeling it.
4. If two classical sources conflict, retain both rules and mark the conflict instead of silently averaging them.
5. If a rule has unclear provenance or is commonly attributed but not verifiable, mark it `unverified`.
6. Do not use Shen Sha as the primary engine unless the relevant rule has a clear source and a defined purpose.
7. Do not use Na Yin as a substitute for the main Zi Ping chart structure.

## Research sources used for v1

- Chinese Text Project — 《三命通会》卷七: https://ctext.org/wiki.pl?chapter=548506&if=gb&remap=gb
- Wikisource — 《三命通会》四库全书本: https://zh.wikisource.org/zh-hans/%E4%B8%89%E5%91%BD%E9%80%9A%E6%9C%83_%28%E5%9B%9B%E5%BA%AB%E5%85%A8%E6%9B%B8%E6%9C%AC%29/%E5%8D%B707
- Wikisource — 《滴天髓》: https://zh.wikisource.org/zh-hans/%E6%BB%B4%E5%A4%A9%E9%AB%93
- Wikisource — 《穷通宝鉴》: https://zh.wikisource.org/zh-hans/%E7%A9%B7%E9%80%9A%E5%AE%9D%E9%91%91
- Classical-text index containing 《渊海子平》《子平真诠》《三命通会》《滴天髓》《穷通宝鉴》《神峰通考》: https://www.deeporacle.ai/dianji

## Next implementation phase

1. Build deterministic Four Pillars calculation with explicit timezone/solar-term conventions.
2. Build a structured natal-chart representation.
3. Implement month-command and seasonal/climate analysis.
4. Implement pattern/useful-factor analysis with source provenance.
5. Implement annual interaction analysis.
6. Map customer questions to relevant evidence domains.
7. Connect the locked tarot deck and core meanings.
8. Give Vera only structured evidence and require her to synthesize the final answer.
9. Create unit tests for boundary dates, solar terms, year changes, and conflicting evidence.

Production rule: this knowledge base is research documentation only until the deterministic engine and tests are implemented and reviewed. It must not alter the current production reading behavior by itself.
