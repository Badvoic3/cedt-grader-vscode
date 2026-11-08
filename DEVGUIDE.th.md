# Grader Submit — คู่มือสำหรับนักพัฒนา

[English](DEVGUIDE.md) · **ภาษาไทย**

[**← กลับไปหน้า README**](README.th.md) · [**คู่มือการใช้งาน (`USERGUIDE.th.md`)**](USERGUIDE.th.md) · [**การขอความช่วยเหลือ (`SUPPORT.th.md`)**](SUPPORT.th.md) · [**ประวัติการเปลี่ยนแปลง (`CHANGELOG.md`)**](CHANGELOG.md)

เอกสารนี้อธิบายโครงสร้างโค้ดของ **Grader Submit** วิธีสั่ง build, รันชุดทดสอบ และสร้างแพ็กเกจ `.vsix` บนเครื่อง รวมถึงแนวทางการพัฒนาต่อยอดสำหรับระบบเชื่อมต่อ Grader และตัวรันทดสอบในตัว

---

## 1. สิ่งที่ต้องเตรียมและคำสั่งหลัก

- **Node.js:** เวอร์ชัน 20 ขึ้นไป
- **VS Code:** เวอร์ชัน `1.106.0` ขึ้นไป (สำหรับรัน Extension Development Host)

```bash
npm install          # ติดตั้ง dependencies ทั้งหมด
npm run build        # ตรวจชนิดข้อมูล (tsc --noEmit) และ bundle โค้ดฝั่ง host กับ webviews (esbuild.mjs)
npm test             # รันชุดทดสอบทั้งหมดด้วย Vitest
npm run typecheck    # รัน tsc --noEmit บน src/, webview/ และ test/
npm run check        # ตรวจสอบครบทุกขั้นตอน: npm run build && npm test
npm run package      # สร้างไฟล์ติดตั้ง .vsix สำหรับใช้งานจริง (cedt-grader-submit-<version>.vsix)
npx vsce ls          # ตรวจสอบรายชื่อไฟล์ทั้งหมดที่จะถูกรวมเข้าไปในแพ็กเกจ .vsix
```

กดปุ่ม <kbd>F5</kbd> ใน VS Code เพื่อเปิดหน้าต่าง **Extension Development Host** สำหรับทดสอบส่วนขยาย

---

## 2. ภาพรวมสถาปัตยกรรม

Grader Submit แบ่งการทำงานออกเป็น 2 ส่วนที่สื่อสารกันผ่านช่องทาง `postMessage` แบบมีการกำหนดชนิดข้อมูลชัดเจน (`src/shared/messages.ts`):

1. **Extension Host (Node.js, `src/` → `dist/extension.js`):**
   - รับผิดชอบสถานะทั้งหมดของระบบ การส่งคำขอเครือข่าย การเก็บรหัสผ่าน (`vscode.SecretStorage`) แคชบนดิสก์ (`context.globalStorageUri`) การตรวจจับการเปลี่ยนแปลงของไฟล์ และการรัน test case บนเครื่อง
   - ส่งข้อมูลสถานะแบบสมบูรณ์ (`ViewState` สำหรับแผงด้านข้าง และ `ToTests` สำหรับหน้าทดสอบ) ไปให้ฝั่ง Webview แสดงผล
2. **Webviews (Browser DOM, `webview/` → `media/dist/*.js`):**
   - ประกอบด้วย **แผงด้านข้าง (`webview/main.ts`)**, **หน้าทดสอบ (`webview/tests.ts`)**, **หน้าต่างอ่านโจทย์ PDF (`webview/statement.ts`)** และ **หน้าพักสายตา (`webview/break.ts`)**
   - สร้าง DOM ด้วยฟังก์ชันช่วยเหลือ (`webview/dom.ts`) กำหนดข้อความผ่าน `textContent` และบังคับใช้ Content Security Policy อย่างเคร่งครัด (`default-src 'none'`, สคริปต์ต้องมี nonce และไม่ใช้ inline style) โดยฝั่ง Webview จะไม่เชื่อมต่อเครือข่ายเองโดยตรง

### โครงสร้างโฟลเดอร์ในโปรเจกต์

| พาธ | หน้าที่รับผิดชอบ |
|---|---|
| `src/extension.ts` | จุดเริ่มต้นของส่วนขยาย (`activate`) การลงทะเบียนคำสั่ง และตัวจัดการ Webview |
| `src/controller.ts` | ตัวประสานงานหลัก (`GraderController`) ที่เชื่อมสถานะ เหตุการณ์ และโมดูลการทำงานเข้าด้วยกัน |
| `src/flows/` | โมดูลแยกตามขั้นตอนการทำงาน: `submit.ts`, `links.ts`, `folderMode.ts`, `attachments.ts`, `runner.ts`, `cache.ts`, `explorerBadges.ts`, `breakReminder.ts`, `serverCheck.ts`, `panelReveal.ts`, `prompts.ts` |
| `src/grader/` | อินเทอร์เฟซ `GraderProvider` (`provider.ts`) การคำนวณคะแนน (`score.ts`) การจับคู่ภาษา (`languages.ts`) การตัดข้อมูลสำคัญ (`redact.ts`) และโค้ดเชื่อมต่อ `cafe-grader-web` (`providers/cafeGrader/`) |
| `src/runner/` | แกนหลักของตัวรันทดสอบบนเครื่องที่ไม่พึ่งพาโมดูล `vscode`: การตรวจหาคอมไพเลอร์ (`languages.ts`) แคชไฟล์ไบนารีตาม hash ของโค้ด (`compile.ts`) การรันโปรเซสแยกกลุ่ม (`execute.ts`) การเปรียบเทียบผลลัพธ์ (`compare.ts`) การคำนวณ diff (`diff.ts`) และการจัดเก็บ test case (`store.ts`) |
| `src/data/` | `DataService` (การรวมคำขอที่ซ้ำกัน การกำหนดอายุแคช และการหยุดทำงานเมื่อซ่อนแผง), `statementStore.ts`, `testcaseStore.ts` และ `pdfSamples.ts` (ตัวดึงตารางตัวอย่างจาก PDF) |
| `src/mapping/` | ตัวจับคู่ไฟล์กับโจทย์ (`match.ts`) ดัชนีไฟล์โค้ดใน workspace (`findByName.ts`) ที่เก็บข้อมูลการเชื่อม (`store.ts`) และตัวตรวจหาบทบาทไฟล์ในโหมดโฟลเดอร์ (`folderRoles.ts`) |
| `src/migration/` | ตัวนำเข้าข้อมูลจาก `v1.0.x` และการย้ายไฟล์ระบบเก่าไปถังขยะ (`importLinks.ts`, `oldFiles.ts`, `cph.ts`) |
| `src/ui/` | ตัวจัดการแผงและแท็บ Webview (`sidebarProvider.ts`, `testPanel.ts`, `statementPanel.ts`, `breakPanel.ts`, `statusBar.ts`, `compareDocs.ts`) |
| `src/shared/` | ค่าคงที่ส่วนกลาง (`constants.ts`) ชนิดข้อความสื่อสาร (`messages.ts`) ตารางข้อความภาษาอังกฤษและภาษาไทย (`strings.ts`, `strings.th.ts`, `i18n.ts`) และคีย์สำหรับเก็บสถานะ (`stateKeys.ts`) |
| `webview/` | โค้ดฝั่งเบราว์เซอร์ (`main.ts`, `tests.ts`, `statement.ts`, `break.ts`, `breakScenes.ts`, `style.css`, `tests.css`) |
| `test/` | ชุดทดสอบ Vitest (`*.test.ts`) ซึ่งใช้เซิร์ฟเวอร์จำลองทั้งหมดและไม่ติดต่อกับเซิร์ฟเวอร์ Grader จริง |

---

## 3. ขอบเขตการออกแบบที่สำคัญ

### ขอบเขต `GraderProvider` (`src/grader/provider.ts`)

`GraderController`, `DataService` และทุกโมดูลใน `src/flows/*` เรียกใช้งานผ่านอินเทอร์เฟซ `GraderProvider` และ `GraderCapabilities` (`{ testcases, pdfStatement, attachments, penaltyHtml, rawSumScores }`) เท่านั้น ส่วนรายละเอียดเฉพาะของ `cafe-grader-web` (เช่น Rails `/api/v1` JWT endpoints, การอ่าน HTML จาก `/main/list`, การจัดการ CSRF และการแปลงข้อความผลตรวจ) จะอยู่ภายใน `src/grader/providers/cafeGrader/` ทั้งหมด หากต้องการรองรับระบบ Grader อื่นในอนาคต สามารถทำได้โดยเพิ่มโฟลเดอร์ provider ใหม่ภายใต้ `src/grader/providers/`

### แกนรันทดสอบที่ไม่พึ่งพา `vscode` (`src/runner/`)

ทุกไฟล์ภายใต้ `src/runner/` ห้าม import โมดูล `vscode` โดยเด็ดขาด (ตรวจสอบอัตโนมัติด้วย `test/providerBoundary.test.ts`):

- **การคอมไพล์ (`src/runner/compile.ts`):** คำนวณ hash จากเนื้อหาไฟล์ที่รัน ไฟล์ header ที่ถูก `#include` ในโฟลเดอร์ คำสั่งคอมไพเลอร์ และอาร์กิวเมนต์ เพื่อเก็บไบนารีไว้ใน `<os.tmpdir()>/cedt-grader-bin/<hash>/` (พร้อมสลับไปใช้ `<globalStorageUri>/bin/` อัตโนมัติหาก `/tmp` ถูกตั้งค่าแบบ `noexec`)
- **การรันโปรเซส (`src/runner/execute.ts`):** สร้างโปรเซสลูกแบบแยกกลุ่มโปรเซส (`detached: true` บน POSIX และ `taskkill /T /F` บน Windows) โดยตั้ง `shell: false` บังคับใช้เวลาจำกัดและขนาดเอาต์พุตสูงสุด (`64 KB` สำหรับการแสดงผล และ `max(64 KB, 2 × expected)` สำหรับการตรวจคำตอบ) รวมถึงวัดค่าหน่วยความจำสูงสุด (`VmHWM` บน Linux และ `/usr/bin/time -l` บน macOS)

### กฎการรวมศูนย์ข้อมูล (ตรวจสอบด้วยชุดทดสอบ)

- **ค่าคงที่และพารามิเตอร์ (`src/shared/constants.ts`):** เวลาหมดอายุ ขนาดแคช ขีดจำกัดของตัวรันทดสอบ และ URL ทั้งหมดรวมอยู่ที่ `src/shared/constants.ts`
- **ข้อความที่แสดงต่อผู้ใช้ (`src/shared/strings.ts` และ `src/shared/strings.th.ts`):** ข้อความบน UI ทูลทิป การแจ้งเตือน และข้อความข้อผิดพลาดทั้งหมดอยู่ในตารางข้อความ (`test/i18n.test.ts` จะตรวจสอบว่าทุกคีย์แปลครบ ตัวแปร placeholder ตรงกันทั้งหมด และไม่มีคีย์ที่ไม่ได้ใช้งานตกค้าง)
- **คีย์สถานะ (`src/shared/stateKeys.ts`):** คีย์ของ `globalState` และ `workspaceState` ทุกตัวต้องลงทะเบียนไว้ใน `KEYS` (`test/stateKeys.test.ts`)

---

## 4. ความปลอดภัยและวินัยในการเชื่อมต่อเซิร์ฟเวอร์

- **ห้ามติดต่อเซิร์ฟเวอร์ Grader จริงในการทดสอบ:** ชุดทดสอบทั้งหมดใช้เซิร์ฟเวอร์ HTTP จำลองบนเครื่องหรือ mock provider เท่านั้น
- **ป้องกันการเปลี่ยนเส้นทางข้ามโดเมน (`src/grader/http.ts`):** ตรวจสอบการ redirect ด้วย `redirect: 'manual'` ทุกครั้ง และปฏิเสธทันทีหากปลายทางมี origin ไม่ตรงกับ `cedtGrader.baseUrl`
- **การปกป้องข้อมูลเข้าสู่ระบบ:** `cedtGrader.baseUrl` กำหนดขอบเขตเป็นระดับ `application` (อ่านจาก User Settings เท่านั้น) เพื่อป้องกันไม่ให้ไฟล์ `.vscode/settings.json` ในโปรเจกต์แอบเปลี่ยนปลายทางที่ส่งรหัสผ่าน ส่วนรหัสผ่านและโทเค็นจะเก็บไว้ใน `vscode.SecretStorage` เท่านั้น
- **การตัดข้อมูลส่วนบุคคล (`src/grader/redact.ts`):** รายงานข้อผิดพลาดและบันทึกคำขอจะตัดโทเค็น คุกกี้ รหัสผ่าน ชื่อผู้ใช้ และพาธโฟลเดอร์ผู้ใช้ (`~`) ออกก่อนแสดงผลเสมอ

---

## 5. ไลบรารีโอเพนซอร์สที่ใช้ (Third-Party Notices)

Grader Submit รวมไลบรารีโอเพนซอร์สต่อไปนี้ไว้ในแพ็กเกจสำหรับใช้งานจริง (ดูเพิ่มเติมใน `package.json` และ `LICENSE`):

| แพ็กเกจ | สัญญาอนุญาต | หน้าที่ใน Grader Submit |
|---|---|---|
| [`cheerio`](https://github.com/cheeriojs/cheerio) | MIT | อ่านข้อมูล HTML จากหน้า `/main/list` เพื่อดึงแท็กหมวดหมู่ คะแนนที่ถูกหัก และสถานะโจทย์แบบคิดคะแนนรวมดิบ |
| [`fflate`](https://github.com/101arrowz/fflate) | MIT | ตรวจสอบและแตกไฟล์แนบ `.zip` ของโจทย์พร้อมจำกัดขนาดข้อมูลแบบสตรีม |
| [`markdown-it`](https://github.com/markdown-it/markdown-it) | MIT | แสดงผลโจทย์ที่เป็นรูปแบบ Markdown ในกรณีที่โจทย์ไม่มีไฟล์ PDF |
| [`pdfjs-dist`](https://github.com/mozilla/pdf.js) | Apache-2.0 | แสดงผลไฟล์ PDF ของโจทย์และดึงตารางตัวอย่างอินพุต/เอาต์พุต |
| [`tough-cookie`](https://github.com/salesforce/tough-cookie) | BSD-3-Clause | จัดการคุกกี้ในหน่วยความจำสำหรับเซสชันของเว็บ Grader |
| [`vscode-textmate`](https://github.com/microsoft/vscode-textmate) | MIT | แยกโทเค็นโค้ดเพื่อให้สีตามไวยากรณ์ภาษาในฉากพักสายตา |
| [`vscode-oniguruma`](https://github.com/microsoft/vscode-oniguruma) | MIT | เอนจิน Regular Expression แบบ WebAssembly สำหรับ `vscode-textmate` (`dist/onig.wasm`) |
| [`@vscode/codicons`](https://github.com/microsoft/vscode-codicons) | MIT / CC-BY-4.0 | ชุดฟอนต์ไอคอนที่รวมไว้ใน `media/dist/` |

สำหรับฉากพักสายตาแบบ `swarm` (`webview/breakScenes.ts`) พัฒนาขึ้นเองด้วยอัลกอริทึมจำลองของไหลบนตาราง 2 มิติ (semi-Lagrangian advection, pressure projection และ vorticity confinement)

---

## 6. แนวทางการร่วมพัฒนา (Contributing)

1. สร้าง branch ใหม่จาก `main` และแยก commit ตามขอบเขตของงานให้ชัดเจน
2. เพิ่มหรืออัปเดตชุดทดสอบใน `test/*.test.ts` (รวมถึงการทดสอบด้วย `vi.mock('vscode')` สำหรับโค้ดส่วนที่เชื่อมต่อกับ VS Code API)
3. หากมีการเพิ่มหรือแก้ไขข้อความที่แสดงต่อผู้ใช้ ให้แก้ไขทั้งใน `src/shared/strings.ts` และ `src/shared/strings.th.ts` (รวมถึง `package.nls.json` / `package.nls.th.json` สำหรับข้อความใน manifest)
4. รัน `npm run check` (`npm run build && npm test`) และตรวจสอบว่าผ่านครบทุกการทดสอบก่อนเปิด Pull Request
