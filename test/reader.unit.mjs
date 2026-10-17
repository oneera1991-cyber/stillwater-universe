import assert from "node:assert/strict";
import { filterQuestionEvidence } from "../api/_lib/reader.js";

const base={
  version:"bazi-v1",
  chart:{
    strength:{level:"balanced"},
    climate:{notes:["cold-season condition"]},
    interactions:[{type:"clash",a:"子",b:"午"}],
    patternCandidates:[{type:"正官"}],
    usefulCandidates:[{element:"火"}]
  },
  annual:{
    year:2026,
    annualStem:"丙",
    annualBranch:"午",
    tenGod:"正官",
    element:"火",
    natalInteractions:[{type:"clash",target:"子"}],
    usefulFactorImpact:["annual stem element 火 matches a candidate useful factor"],
    climateImpact:["cold-season condition"],
    overallDirection:"challenging"
  },
  question:{
    domains:["career"],
    evidence:[
      {
        statement:"annual 午 clash with natal 子",
        source:{work:"Stillwater annual interaction rule",layer:"stillwater-rule"},
        conditions:["clash"],
        observations:["子"],
        relevance:"high",
        confidence:.75
      }
    ]
  }
};

const career=filterQuestionEvidence(base,"ปี 2026 ควรลาออกจากงานไหม");
assert.deepEqual(career.domains,["career"]);
assert.equal(career.evidence.length,1);
assert.equal(career.annual.annualStem,"丙");
assert.equal(career.annual.annualBranch,"午");
assert.equal(career.chart.strength.level,"balanced");

const relationship=filterQuestionEvidence(base,"ปี 2026 ความรักจะเป็นอย่างไร");
assert.deepEqual(relationship.domains,["relationship"]);
assert.ok(relationship.chart.interactions);
assert.equal(relationship.annual.year,2026);

const health=filterQuestionEvidence(base,"ปี 2026 สุขภาพเป็นอย่างไร");
assert.deepEqual(health.domains,["health"]);
assert.ok(health.chart.climate);

console.log("reader.unit.mjs: PASS");
