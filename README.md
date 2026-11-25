# AM32 Offline – AM32 konfigūratorius Android telefonui

[am32.ca](https://am32.ca) konfigūratorius, supakuotas į Android programėlę. Pati sąsaja yra
APK viduje, todėl ESC nustatymus galima skaityti ir keisti visai be interneto. Firmware į
APK nededamas: programėlė jį atsisiunčia iš am32.ca, kai yra ryšys, ir išsaugo telefone.

## Kaip tai veikia

| Dalis | Kas tai |
| --- | --- |
| `android/app/src/main/assets/www` | Originalus konfigūratorius ([am32-firmware/am32-configurator](https://github.com/am32-firmware/am32-configurator)), sukompiliuotas į statinį puslapį. Generuojamas, į git nededamas. |
| `LocalContent.kt` | Atstoja am32.ca serverį: WebView visas užklausas gauna iš čia. Puslapio failai – iš APK, `/api/...` – per `RemoteCache`. |
| `RemoteCache.kt` | Vienintelė vieta, kuri jungiasi prie interneto (tik `https://am32.ca`). Viską, ką atsisiuntė, laiko telefone. `.hex` failai prieš išsaugant patikrinami (Intel HEX kontrolinės sumos). |
| `UsbSerialBridge.kt` + `assets/bridge/bridge.js` | Android WebView neturi Web Serial API. `bridge.js` puslapiui pateikia `navigator.serial`, o tikrą darbą per USB atlieka [usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) (CDC-ACM skrydžio valdikliai, CH340, FTDI, CP210x, Prolific). |
| `FileBridge.kt` | „Atsisiuntimai“ iš puslapio (ESC konfigūracija, `.hex`) – į `Download/AM32`. |

### Su internetu ir be jo

- **Yra internetas:** firmware sąrašas atnaujinamas iš am32.ca (ne dažniau kaip kas 5 min.),
  nauji leidimai matomi iškart. Pasirinktas failas atsisiunčiamas ir lieka telefone.
- **Nėra interneto:** rodomi tik tie firmware failai, kurie jau yra telefone. Norint
  lauke flashinti be ryšio, reikiamą failą reikia bent kartą atsisiųsti namie: skiltyje
  **Downloads** paspausti ant savo ESC `.hex` (arba vieną kartą jį suflashinti).
- ESC nustatymų skaitymas, keitimas, konfigūracijos išsaugojimas / įkėlimas iš failo ir
  flashinimas iš vietinio `.hex` failo interneto nereikalauja niekada.

Atsisiųsti failai laikomi programėlės vidinėje atmintyje; išvalyti galima per
*Nustatymai → Programos → AM32 Offline → Saugykla → Išvalyti duomenis*.

## Naudojimas telefone

1. Įdiekite `dist\AM32-Offline-<versija>.apk` (reikės leisti diegimą iš nežinomų šaltinių).
2. Prijunkite skrydžio valdiklį arba USB–serial adapterį per **USB OTG** laidą / adapterį.
   Android pasiūlys atidaryti *AM32 Offline* – sutikite (taip iškart suteikiama USB prieiga).
3. Programėlėje: **Port select** → pasirinkite įrenginį → **Connect**.
   Tiesioginiam jungimui prie vieno ESC per adapterį pažymėkite **Direct**.

Ekranas programėlėje neužgęsta, kad flashinimas nenutrūktų. Flashinimo metu neatjunkite
laido ir neuždarykite programėlės.

## Surinkimas (Windows)

```powershell
powershell -ExecutionPolicy RemoteSigned -File scripts\build.ps1
```

Skriptas sukompiliuoja konfigūratorių ir surenka pasirašytą APK. Trūkstamus įrankius
(Node 20, JDK 17, Gradle) atsisiunčia į `tools\` – sistemoje niekas nediegiama.

Šiam kompiuteriui skirti nustatymai yra `scripts\env.local.ps1`:

- `AM32_ANDROID_SDK` – jau esantis Android SDK (dabar `D:\esc-configurator-android-build\android-sdk`).
  Jei šio nustatymo nėra, SDK atsiunčiamas į `tools\android-sdk` ir paprašoma sutikti su
  Google licencijomis.
- `AM32_BUILD_ROOT` – kur vyksta visas build darbas (dabar `D:\am32-android-build`).
  Projektas guli išoriniame exFAT diske, kuriame `node_modules` ir Gradle yra nepakenčiamai
  lėti, todėl kompiliuojama vidiniame NTFS diske. Tą aplanką galima bet kada ištrinti –
  kitas surinkimas jį atkurs.

| Komanda | Ką daro |
| --- | --- |
| `scripts\build.ps1` | Viskas nuo nulio. |
| `scripts\build.ps1 -SkipWeb` | Tik Android dalis, web dalis paliekama esama. |
| `scripts\build.ps1 -WebRef master` | Naujausias konfigūratoriaus kodas vietoj užfiksuotos versijos. |

Konfigūratoriaus versija užfiksuota `scripts\build-web.ps1` (`$Ref`). Kai išeina naujas AM32
firmware su pakeistu nustatymų (EEPROM) išdėstymu, gali reikėti ir naujesnio konfigūratoriaus:
pakelkite `$Ref` (arba naudokite `-WebRef master`), padidinkite `versionCode` / `versionName`
faile `android\app\build.gradle.kts` ir surinkite iš naujo. Ką tiksliai keičiame originaliame
kode, aprašyta `scripts\patch-web.mjs` pradžioje.

### Pasirašymo raktas

Pirmo surinkimo metu sukuriamas `android\signing\` (raktas + slaptažodis). Android leidžia
atnaujinti programėlę tik tuo pačiu raktu pasirašytu APK, todėl **pasidarykite šio aplanko
kopiją**. Jį praradus, naują versiją pavyks įdiegti tik prieš tai pašalinus senąją.

## Testai

Abu leidžiami kompiuterio naršyklėje (headless Chrome / Edge), telefono nereikia.

```powershell
tools\node\node.exe tests\bridge-test.mjs D:\am32-android-build\web-src
tools\node\node.exe tests\e2e-test.mjs
```

- `bridge-test` – tikrina `bridge.js` (`navigator.serial` pakaitalą) su tomis pačiomis serial
  bibliotekomis, kurias naudoja konfigūratorius, ir netikru USB sluoksniu.
- `e2e-test` – paleidžia tikrą, į APK dedamą konfigūratorių telefono dydžio ekrane (412 px)
  su imituotu skrydžio valdikliu ir keturiais ESC (`tests\mock-native.js`):
  *Port select → Connect → Read → Disconnect*, ikonos, firmware sąrašas iš am32.ca ir
  maketas (ar niekas neišlenda už ekrano, ar ESC būsenos taškai neuždengia pavadinimų).
  Kaip ir programėlėje, puslapiui neleidžiama pasiekti jokio kito serverio.
  Nurodžius aplanką (`tests\e2e-test.mjs C:\kur\nors`), ten išsaugomos telefono dydžio
  ekrano nuotraukos: pradžia, atsisiuntimai, nustatymai, „Tune“ ir „Flash firmware“.

`tools\node\node.exe tests\preview-server.mjs` paleidžia tą patį peržiūrai naršyklėje
(`http://127.0.0.1:5173/`) – patogu žiūrint sąsają be telefono.

Ko testai neapima: Kotlin pusės (tikras USB ryšys su ESC, flashinimas). Tam reikia telefono
su OTG laidu ir įrenginio.

Telefono maketo pataisos yra `android\app\src\main\assets\bridge\mobile.css`: nustatymų
grupės per visą plotį ir po du laukus eilėje, ESC būsenos taškai atskiroje eilutėje virš
pavadinimo, ESC kortelės viena po kita, failų sąrašas viename stulpelyje, telpanti apatinė
juosta. Originalus konfigūratoriaus kodas dėl to nekeičiamas.

## Pastabos

- Konfigūratoriaus šaltinis atsisiunčiamas kaip archyvas, o ne klonuojamas: exFAT diske git
  neveikia be `safe.directory` išimties.
- Programėlė neturi jokios analitikos; originalaus puslapio Matomo skriptas pašalintas.
  Internete ji kreipiasi tik į `https://am32.ca`.
