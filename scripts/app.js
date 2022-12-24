var games = [
    "newmario",
    "fifa11",
    "pkmnheartgold",
    "pkmnplatine",
    "pkmnwhite",
]

var gamesDownloadLink = {
    "pkmnheartgold":"https://download947.mediafire.com/kq7j3hyr49wg/rbnqf9j50kiqkxw/pkmnheartgold.nds",
    "pkmnplatine":"https://download1519.mediafire.com/hr9k9ratdkqg/2kplyck6j7p1xq6/pkmnplatine.nds",
    "pkmnwhite":"https://download1593.mediafire.com/71cneptfe2zg/yeib6lxkb0fwgio/pkmnwhite.nds",
}


var plugins = {}
var body = document.getElementsByTagName("body")[0]
var html = document.getElementsByTagName("html")[0]


window.onerror = function (msg, url, line, col, error) {
    var extra = !col ? '' : '\ncolumn: ' + col;
    extra += !error ? '' : '\nerror: ' + error;
    alert("Error: " + msg + "\nurl: " + url + "\nline: " + line + extra);
    window.onerror = console.log
    debugger
    return true;
};

function $id(id) {
    return document.getElementById(id);
}

var isIOS = !!navigator.platform && /iPad|iPhone|iPod/.test(navigator.platform);
var isWebApp = navigator.standalone || false
var isSaveSupported = true
var isSaveNagAppeared = false
if (isIOS) {
    //document.getElementById('romFile').files = null;
    if (!isWebApp) {
        // On iOS Safari, the indexedDB will be cleared after 7 days. 
        // To prevent users from frustration, we don't allow savegame on iOS unless the we are in the PWA mode.
        isSaveSupported = false
        var divIosHint = $id('ios-hint')
        divIosHint.hidden = false
        divIosHint.style = 'position: absolute; bottom: ' + divIosHint.clientHeight + 'px;'
    }
}

var emuKeyState = new Array(14)
const emuKeyNames = ["right", "left", "down", "up", "select", "start", "b", "a", "y", "x", "l", "r", "debug", "lid"]
var vkMap = {}
var vkState = {}
var keyNameToKeyId = {}
var vkStickPos
for (var i = 0; i < emuKeyNames.length; i++) {
    keyNameToKeyId[emuKeyNames[i]] = i
}
var currentConnectedGamepad = -1

const emuKeyboradMapping = [39, 37, 40, 38, 16, 13, 90, 88, 65, 83, 81, 87, -1, 8]
var emuGameID = 'unknown'
var emuIsRunning = false
var fps = 0
var divFPS = $id('fps')
var fileInput = $id('rom')
var romSize = 0

var FB = [0, 0]
var screenCanvas = [document.getElementById('top'), document.getElementById('bottom')]
var ctx2d = screenCanvas.map((v) => { return v.getContext('2d', { alpha: false }) })

var audioContext
var scriptProcessor
var AUDIO_BLOCK_SIZE = 2048
var AUDIO_ORIG_SAMPLES_DESIRED = AUDIO_BLOCK_SIZE
var audioBuffer
var tmpAudioBuffer = new Int16Array(16384 * 2)
var audioWorkletNode

var frameCount = 0
var prevCalcFPSTime = 0
var shouldDraw = false
var touched = 0
var touchX = 0
var touchY = 0
var prevSaveFlag = 0
var lastTwoFrameTime = 10
var fbSize

function callPlugin(type, arg) {
    for (var k in plugins) {
        if (plugins[k].handler) {
            plugins[k].handler(type, arg)
        }
    }
}

function showMsg(msg) {
    document.getElementById('msg-text').innerText = msg
    document.getElementById('msg-layer').hidden = false
    if (msg.indexOf("%") > -1) {
        setTimeout(function () {
            document.getElementById('msg-layer').hidden = true
        }, 1000)
    } else {
        setTimeout(function () {
            document.getElementById('msg-layer').hidden = true
        }, 3500)
    }
}

function emuRunFrame() {
    var keyMask = 0;
    for (var i = 0; i < 14; i++) {
        if (emuKeyState[i]) {
            keyMask |= 1 << i
        }
    }
    shouldDraw = true
    Module._runFrame(shouldDraw ? 1 : 0, keyMask, touched, touchX, touchY)
    if (shouldDraw) {
        ctx2d[0].putImageData(FB[0], 0, 0)
        ctx2d[1].putImageData(FB[1], 0, 0)
    }
    if (audioWorkletNode) {
        try {
            var samplesRead = Module._fillAudioBuffer(4096)
            tmpAudioBuffer.set(audioBuffer.subarray(0, samplesRead * 2))
            audioWorkletNode.port.postMessage(tmpAudioBuffer.subarray(0, samplesRead * 2))
        } catch (error) {
            // tmpAudioBuffer may be detached if previous message is still processing 
            console.log(error)
        }
    }

    frameCount += 1
    if (frameCount % 120 == 0) {
        var time = performance.now()
        fps = 120 / ((time - prevCalcFPSTime) / 1000)
        prevCalcFPSTime = time
        divFPS.innerText = 'fps:' + ('' + fps).substring(0, 5)
    }
    if (frameCount % 120 == 0) {
        checkSaveGame()
    }
}

function wasmReady() {
    $id('loading').hidden = true
    $id('loadrom').hidden = false
    //setInterval(emuRunFrame, 1000/120)
}


function checkSaveGame() {
    var saveUpdateFlag = Module._savUpdateChangeFlag()
    if ((saveUpdateFlag == 0) && (prevSaveFlag == 1)) {
        var size = Module._savGetSize()
        if ((size > 0) && (isSaveSupported)) {
            var ptr = Module._savGetPointer(0)
            var tmpSaveBuf = new Uint8Array(size)
            tmpSaveBuf.set(Module.HEAPU8.subarray(ptr, ptr + size))
            localforage.setItem('sav-' + gameID, tmpSaveBuf)
            showMsg('Auto saving...')
        }
    }
    prevSaveFlag = saveUpdateFlag
}

async function tryLoadROM(file) {
    if (!file) {
        return
    }
    if (file.size < 1024) {
        return
    }
    var header = new Uint8Array(await (file.slice(0, 1024)).arrayBuffer())
    gameID = ''
    for (var i = 0; i < 0x10; i++) {
        gameID += (header[i] == 0) ? ' ' : String.fromCharCode(header[i])
    }
    if (gameID[0xC] == '#') {
        // a homebrew!
        gameID = file.name
    }
    console.log('gameID', gameID)
    romSize = file.size
    var romBufPtr = Module._prepareRomBuffer(romSize)
    console.log(romSize, romBufPtr)
    Module.HEAPU8.set(new Uint8Array(await file.arrayBuffer()), romBufPtr);
    var saveData = await localforage.getItem('sav-' + gameID)
    if (saveData) {
        Module.HEAPU8.set(saveData, Module._savGetPointer(saveData.length))
    }
    Module._savUpdateChangeFlag()
    var ret = Module._loadROM(romSize);
    if (ret != 1) {
        alert('LoadROM failed.')
        return;
    }


    ptrFrontBuffer = Module._getSymbol(5)
    var fb = Module._getSymbol(4)
    for (var i = 0; i < 2; i++) {
        FB[i] = new ImageData(new Uint8ClampedArray(Module.HEAPU8.buffer).subarray(fb + 256 * 192 * 4 * i, fb + 256 * 192 * 4 * (i + 1)), 256, 192)
    }
    var ptrAudio = Module._getSymbol(6)
    audioBuffer = new Int16Array(Module.HEAPU8.buffer).subarray(ptrAudio / 2, ptrAudio / 2 + 16384 * 2)
    console.log('Start!!!')
    emuIsRunning = true
    uiSwitchToPlayer()
    callPlugin('loaded', gameID)
}

async function downloadAndLoadROM(locationHash) {
    showMsg(`Downloading ${locationHash}. Please do not close/reload the page`);
  
    if (games.indexOf(locationHash) > -1) {
      let arrayBuffer = await localforage.getItem(locationHash);
      if (arrayBuffer === null) {
        try {
          let xhr = new XMLHttpRequest();
          xhr.responseType = "arraybuffer";
  
          xhr.onprogress = function(event) {
            let progress = (event.loaded / event.total) * 100;
            showMsg(`Download progress: ${progress}%`);
          };
  
          let url;
          if (!gamesDownloadLink[locationHash]) {
            console.log("From GitHub");
            url = `./roms/${locationHash}.nds`;
          } else {
            console.log("From Link");
            url = gamesDownloadLink[locationHash];
          }
  
          xhr.open("GET", url);
          xhr.send();
  
          let data = await new Promise((resolve, reject) => {
            xhr.onload = () => {
              if (xhr.status === 200) {
                resolve(xhr.response);
              } else {
                reject(new Error("DOWNLOAD ERROR"));
              }
            };
          });
  
          await localforage.setItem(locationHash, data);
          data = null;
  
          let file = new File([data], `${locationHash}.nds`, {
            type: "application/octet-stream"
          });
          tryLoadROM(file);
          file = null
        } catch (error) {
          console.error(error);
        }
      } else {
        let file = new File([arrayBuffer], `${locationHash}.nds`, {
          type: "application/octet-stream"
        });

        arrayBuffer = null;
        tryLoadROM(file);
        file = null;
      }
    } else {
      alert(`Game Not Found! ${locationHash}`);
    }
  }


function initVK() {
    var vks = document.getElementsByClassName('vk')
    for (var i = 0; i < vks.length; i++) {
        var vk = vks[i]
        var k = vks[i].getAttribute('data-k')
        if (k) {
            vkMap[k] = vk
            vkState[k] = [0, 0]
        }
    }
}
initVK()

function makeVKStyle(top, left, w, h, fontSize) {
    return 'top:' + top + 'px;left:' + left + 'px;width:' + w + 'px;height:' + h + 'px;' + 'font-size:' + fontSize + 'px;line-height:' + h + 'px;'
}


function adjustVKLayout() {
    var isLandscape = window.innerWidth > window.innerHeight
    var baseSize = window.innerWidth * 0.14
    var fontSize = baseSize * 0.7
    var offTop = fbSize[0][1] + fbSize[1][1]
    var offLeft = 0
    var abxyWidth = baseSize * 3
    var abxyHeight = baseSize * 3
    var vkw = baseSize
    var vkh = baseSize

    vkw = baseSize * 1.5
    vkh = baseSize * 0.6
    fontSize = baseSize * 0.5
    vkMap['l'].style = makeVKStyle(offTop, 0, vkw, vkh, fontSize)
    vkMap['r'].style = makeVKStyle(offTop, window.innerWidth - vkw, vkw, vkh, fontSize)
    $id('vk-menu').style = makeVKStyle(offTop, window.innerWidth / 2 - vkw / 2, vkw, vkh, fontSize)


    offTop += baseSize * 0.62
    vkw = baseSize
    vkh = baseSize
    offLeft = window.innerWidth - abxyWidth
    vkMap['a'].style = makeVKStyle(offTop + abxyHeight / 2 - vkh / 2, offLeft + abxyWidth - vkw, vkw, vkh, fontSize)
    vkMap['b'].style = makeVKStyle(offTop + abxyHeight - vkh, offLeft + abxyWidth / 2 - vkw / 2, vkw, vkh, fontSize)
    vkMap['x'].style = makeVKStyle(offTop, offLeft + abxyWidth / 2 - vkw / 2, vkw, vkh, fontSize)
    vkMap['y'].style = makeVKStyle(offTop + abxyHeight / 2 - vkh / 2, offLeft, vkw, vkh, fontSize)

    vkw = baseSize * 1.5
    vkh = baseSize * 1.5
    offLeft = 0
    $id('vk-stick').style = makeVKStyle(offTop + abxyHeight / 2 - vkh / 2, offLeft + abxyHeight / 2 - vkw / 2, vkw, vkh, fontSize)
    vkStickPos = [offTop + abxyHeight / 2, offLeft + abxyHeight / 2, vkw, vkh, fontSize]

    vkw = baseSize * 0.4
    vkh = baseSize * 0.4
    fontSize = baseSize * 0.4
    vkMap['select'].style = makeVKStyle(offTop + abxyHeight - vkh, window.innerWidth / 2 - vkw * 1.5, vkw, vkh, fontSize)
    vkMap['start'].style = makeVKStyle(offTop + abxyHeight - vkh, window.innerWidth / 2 + vkw * 0.5, vkw, vkh, fontSize)
}

function uiAdjustSize() {
    var maxWidth = window.innerWidth
    var maxHeight = window.innerHeight / 2
    var w = maxWidth
    var h = w / 256 * 192
    if (h > maxHeight) {
        h = maxHeight
        w = h / 192 * 256
    }
    var left = 0
    left += (window.innerWidth - w) / 2;
    var top = 0

    fbSize = [[w, h], [w, h]]
    for (var i = 0; i < 2; i++) {
        screenCanvas[i].style = 'left:' + left + 'px;top:' + top + "px;width:" + w + "px;height:" + h + "px;"
        top += h
    }
    adjustVKLayout()
}

function uiSwitchToPlayer() {
    for (var i = 0; i < 14; i++) {
        emuKeyState[i] = false
    }
    body.style = 'touch-action: none;'
    html.style = 'position: fixed;overflow:hidden;touch-action: none;'
    $id('welcome').hidden = true
    $id('vk-layer').hidden = false
    uiAdjustSize()
}

fileInput.onchange = async () => {
    tryInitSound()
    var file = fileInput.files[0]
    if (!file) {
        return
    }
    if (file.name.endsWith('.json')) {
        var obj = JSON.parse(await file.text())
        var pluginName = obj.name || 'unknown'
        plugins[pluginName] = obj
        if (obj.js) {
            plugins[pluginName].handler = eval(obj.js)(obj)
        }
        alert('plugin loaded!')
        return
    }
    await tryLoadROM(file)
}

function processAudio(event) {
    var outputBuffer = event.outputBuffer
    var audioData0 = outputBuffer.getChannelData(0)
    var audioData1 = outputBuffer.getChannelData(1)
    if ((!emuIsRunning) || (fps <= 10)) {
        for (var i = 0; i < AUDIO_BLOCK_SIZE; i++) {
            audioData0[i] = 0
            audioData1[i] = 0
        }
        return
    }
    var samplesRead = Module._fillAudioBuffer(AUDIO_BLOCK_SIZE)
    for (var i = 0; i < samplesRead; i++) {
        audioData0[i] = audioBuffer[i * 2] / 32768.0
        audioData1[i] = audioBuffer[i * 2 + 1] / 32768.0
    }
    for (var i = samplesRead; i < AUDIO_BLOCK_SIZE; i++) {
        audioData0[i] = 0
        audioData1[i] = 0
    }
}

// must be called in user gesture
async function tryInitSound() {
    try {
        if (audioContext) {
            if (audioContext.state != 'running') {
                audioContext.resume()
            }
            return;
        }
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 0.0001, sampleRate: 48000 });
        if (!audioContext.audioWorklet) {
            alert('AudioWorklet is not supported in your browser...')
            /*
            console.warn('audio worklet not supported, falling back to script processor...')
            // fall back to the scriptprocessor
            scriptProcessor = audioContext.createScriptProcessor(AUDIO_BLOCK_SIZE, 0, 2)
            scriptProcessor.onaudioprocess = processAudio
            scriptProcessor.connect(audioContext.destination)*/
        } else {
            await audioContext.audioWorklet.addModule("./scripts/audio-worklet.js")
            audioWorkletNode = new AudioWorkletNode(audioContext, "my-worklet", { outputChannelCount: [2] })
            audioWorkletNode.connect(audioContext.destination)
        }

        audioContext.resume()
    } catch (e) {
        console.log(e)
        //alert('Cannnot init sound ')
    }
}


function emuLoop() {
    window.requestAnimationFrame(emuLoop)
    if (emuIsRunning) {
        emuRunFrame()
    }
}
emuLoop()

var stickTouchID = false

function isPointInRect(x, y, r) {
    if ((x >= r.x) && (x < r.x + r.width)) {
        if ((y >= r.y) && (y < r.y + r.height)) {
            return true
        }
    }
    return false
}

function handleTouch(event) {
    tryInitSound()
    if (!emuIsRunning) {
        return
    }
    event.preventDefault();
    event.stopPropagation();

    var isDown = false
    var x = 0
    var y = 0

    var needUpdateStick = false
    var stickY = vkStickPos[0]
    var stickX = vkStickPos[1]
    var stickW = vkStickPos[2]
    var stickH = vkStickPos[3]

    var stickPressed = false
    var stickDeadZone = stickW * 0.2

    var tsRect = screenCanvas[1].getBoundingClientRect()

    for (var i = 0; i < emuKeyState.length; i++) {
        emuKeyState[i] = false
    }
    for (var k in vkState) {
        vkState[k][1] = 0
    }

    for (var i = 0; i < event.touches.length; i++) {
        var t = event.touches[i];
        var tid = t.identifier
        var dom = document.elementFromPoint(t.clientX, t.clientY)
        var k = dom.getAttribute('data-k')
        if ((tid === stickTouchID) || (dom == vkMap['stick'])) {
            stickPressed = true

            vkState['stick'][1] = 1
            var sx = t.clientX
            var sy = t.clientY
            if (sx < stickX - stickDeadZone) {
                emuKeyState[1] = true 
            }
            if (sx > stickX + stickDeadZone) {
                emuKeyState[0] = true
            }
            if (sy < stickY - stickDeadZone) {
                emuKeyState[3] = true
            }
            if (sy > stickY + stickDeadZone) {
                emuKeyState[2] = true
            }
            sx = Math.max(stickX - stickW / 2, sx)
            sx = Math.min(stickX + stickW / 2, sx)
            sy = Math.max(stickY - stickH / 2, sy)
            sy = Math.min(stickY + stickH / 2, sy)
            stickX = sx
            stickY = sy
            needUpdateStick = true
            stickTouchID = tid
            continue
        }
        if (k) {

            vkState[k][1] = 1
            continue
        }


        if (isPointInRect(t.clientX, t.clientY, tsRect)) {
            isDown = true
            x = (t.clientX - tsRect.x) / tsRect.width * 256
            y = (t.clientY - tsRect.y) / tsRect.height * 192
        }

    }

    touched = isDown ? 1 : 0;
    touchX = x
    touchY = y

    for (var k in vkState) {
        if (vkState[k][0] != vkState[k][1]) {
            var dom = vkMap[k]
            vkState[k][0] = vkState[k][1]
            if (vkState[k][1]) {
                dom.classList.add('vk-touched')
            } else {
                dom.classList.remove('vk-touched')
                if (k == "stick") {
                    stickTouchID = false
                    needUpdateStick = true
                }
            }

        }
    }

    for (var i = 0; i < emuKeyState.length; i++) {
        var k = emuKeyNames[i]
        if (vkState[k]) {
            if (vkState[k][1]) {
                emuKeyState[i] = true
            }
        }
    }

    if (needUpdateStick) {
        vkMap['stick'].style = makeVKStyle(stickY - stickW / 2, stickX - stickW / 2, stickW, stickH, vkStickPos[4])
    }
}
['touchstart', 'touchmove', 'touchend', 'touchcancel', 'touchenter', 'touchleave'].forEach((val) => {
    window.addEventListener(val, handleTouch)
})




window.onmousedown = window.onmouseup = window.onmousemove = (e) => {
    if (!emuIsRunning) {
        return
    }
    if (e.type == 'mousedown') {
        tryInitSound()
    }

    var r = screenCanvas[1].getBoundingClientRect()

    e.preventDefault()
    e.stopPropagation()
    
    var isDown = (e.buttons != 0) && (isPointInRect(e.clientX, e.clientY, r))
    var x = (e.clientX - r.x) / r.width * 256
    var y = (e.clientY - r.y) / r.height * 192

    touched = isDown ? 1 : 0;
    touchX = x
    touchY = y
}

window.onresize = window.onorientationchange = () => {
    uiAdjustSize()
}
function convertKeyCode(keyCode) {
    for (var i = 0; i < 14; i++) {
        if (keyCode == emuKeyboradMapping[i]) {
            return i
        }
    }
    return -1
}
window.onkeydown = window.onkeyup = (e) => {
    if (!emuIsRunning) {
        return
    }
    e.preventDefault()
    var isDown = (e.type === "keydown")
    var k = convertKeyCode(e.keyCode)
    if (k >= 0 && currentConnectedGamepad == -1) {
        emuKeyState[k] = isDown
    }
}

var gamePadKeyMap = {
    a: 1,
    b: 0,
    x: 3,
    y: 2,
    l: 4,
    r: 5,
    'select': 8,
    'start': 9,
    'up': 12,
    'down': 13,
    'left': 14,
    'right': 15
}

function processGamepadInput() {
    if (currentConnectedGamepad < 0) {
        return
    }
    var gamepad = navigator.getGamepads()[currentConnectedGamepad]
    if (!gamepad) {
        console.log('Gamepad disconnected.')
        currentConnectedGamepad = -1
        return
    }
    for (var i = 0; i < emuKeyState.length; i++) {
        emuKeyState[i] = false
    }
    for (var k in gamePadKeyMap) {
        if (gamepad.buttons[gamePadKeyMap[k]].pressed) {
            emuKeyState[keyNameToKeyId[k]] = true
        }
    }
    if (gamepad.axes[0] < -0.5) {
        emuKeyState[keyNameToKeyId['left']] = true
    }
    if (gamepad.axes[0] > 0.5) {
        emuKeyState[keyNameToKeyId['right']] = true
    }
    if (gamepad.axes[1] < -0.5) {
        emuKeyState[keyNameToKeyId['up']] = true
    }
    if (gamepad.axes[1] > 0.5) {
        emuKeyState[keyNameToKeyId['down']] = true
    }
}

if (isSaveSupported) {
    window.addEventListener("gamepadconnected", function (e) {
        console.log("Gamepad connected at index %d: %s. %d buttons, %d axes.",
            e.gamepad.index, e.gamepad.id,
            e.gamepad.buttons.length, e.gamepad.axes.length);
        console.log('Gamepad connected.')
        currentConnectedGamepad = e.gamepad.index
        setInterval(processGamepadInput, 50);
    });
}

if (location.hash.substr(1) != '') {
    tryInitSound()
    downloadAndLoadROM(location.hash.substr(1))
}