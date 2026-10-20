import { useState, useRef, useEffect, useMemo } from "react";
import { RuntimePersistenceWarning } from "./lib/runtime-persistence-warning.mjs";
import { InstanceConfigEditor } from "./lib/instance-config-editor.jsx";
import { InstanceCredentialEditor } from "./lib/instance-credential-editor.jsx";
import { InstanceRconConsole } from "./lib/instance-rcon-console.jsx";
import { InstanceMasterStatus } from "./lib/instance-master-status.jsx";
import { InstancePluginManager } from "./lib/instance-plugin-manager.jsx";
import { B3DependencyPanel } from "./lib/b3-dependency-panel.jsx";
import { InstanceB3Runtime } from "./lib/instance-b3-runtime.jsx";
import { InstanceB3Database } from "./lib/instance-b3-database.jsx";
import { InstanceB3Admin } from "./lib/instance-b3-admin.jsx";

/**
 * COD4X CONTROL — CoD4x 21.5 Admin Panel
 *
 * Frontend-only build:
 * - Server Config Builder
 * - Mod selector
 * - Map Rotation Builder
 * - RCON reference
 * - Dvar browser
 * - GSC Assistant via configurable backend proxy (/api/gsc)
 * - German / English language switcher
 *
 * Security:
 * Never put an Anthropic/OpenAI API key in this React bundle.
 * The GSC assistant expects a backend endpoint at POST /api/gsc.
 */

const API_BASE = "http://127.0.0.1:8787";
function apiUrl(path){ return `${API_BASE}${path.startsWith("/")?path:`/${path}`}`; }
function authHeaders(extra={}){ const token=localStorage.getItem("cod4x.auth.token"); return token?{...extra,Authorization:`Bearer ${token}`}:{...extra}; }
function apiFetch(input, init={}){ return fetch(input,{...init,headers:authHeaders(init.headers || {})}); }

const C = {
  bg: "#070b09", surface: "#0b120f", card: "#101915", border: "#26382f",
  accent: "#6bc47b", accentHov: "#8bdd96", accentDim: "#12271a",
  text: "#e5eee8", muted: "#82938a", danger: "#d45c5c", success: "#6bc47b",
  blue: "#7ca8c2", code: "#050806",
};

const MAPS = [
  ["mp_backlot","Backlot"],["mp_bloc","Bloc"],["mp_bog","Bog"],["mp_broadcast","Broadcast"],
  ["mp_carentan","Carentan"],["mp_citystreets","City Streets"],["mp_convoy","Convoy"],
  ["mp_countdown","Countdown"],["mp_crash","Crash"],["mp_crash_snow","Winter Crash"],
  ["mp_creek","Creek"],["mp_crossfire","Crossfire"],["mp_district","District"],
  ["mp_downpour","Downpour"],["mp_facade","Façade"],["mp_farm","Farm"],
  ["mp_killhouse","Killhouse"],["mp_lavacrown","Lavacrown"],["mp_overgrown","Overgrown"],
  ["mp_pipeline","Pipeline"],["mp_shipment","Shipment"],["mp_showdown","Showdown"],
  ["mp_strike","Strike"],["mp_vacant","Vacant"],
].map(([id,name]) => ({id,name}));

const MODES = [
  ["dm","Free For All"],["war","Team Deathmatch"],["sab","Sabotage"],["sd","Search & Destroy"],
  ["dom","Domination"],["koth","Headquarters"],["ctf","Capture the Flag"],["dd","Demolition"],
].map(([id,name]) => ({id,name}));

// These are selectable presets, not claims that every server has these mods installed.
// Custom installations can be added through the Custom Mod field.
const MODS = [
  { id: "", name: "Vanilla / Basisspiel", folder: "", description: "Kein fs_game — Basisspiel verwenden." },
  { id: "mods/pml220", name: "Promod LIVE 2.20", folder: "mods/pml220", description: "Promod LIVE 2.20 preset." },
  { id: "mods/pml220_custom", name: "Promod LIVE 2.20 Custom", folder: "mods/pml220_custom", description: "Beispiel-Preset für eine angepasste Promod-Installation." },
];


const ANTI_CHEAT_PROFILES = [
  { id:"none", name:"Disabled", source:"none" },
  { id:"fpschallenge", name:"FPSChallenge Anti-Cheat (FPSAC)", source:"fpschallenge.eu" },
  { id:"cod4x", name:"CoD4x Anti-Cheat Settings", source:"CoD4x" },
  { id:"ruscod", name:"RUSCOD Anti-Cheat", source:"ruscod.com" },
];

const COD4X_VERSIONS = [
  { id: "21.5", name: "CoD4x 21.5", note: "Latest target in this panel" },
  { id: "21.4", name: "CoD4x 21.4", note: "Compatibility profile" },
  { id: "21.3", name: "CoD4x 21.3", note: "Compatibility profile" },
  { id: "21.2", name: "CoD4x 21.2", note: "Compatibility profile" },
];

const FPS_PROMOD_VERSIONS = [
  { id: "2.85", name: "FPS Promod 2.85 — FPSChallenge.eu", note: "Official FPSChallenge.eu hosted package" },
  { id: "custom", name: "FPS Promod — Custom/Other", note: "Manually installed release" },
];

const COD4X_VERSION_MATRIX = [
  {version:"21.2",releaseVerified:true,source:"callofduty4x/CoD4x_Server",status:"verified-release"},
  {version:"21.3",releaseVerified:false,source:"callofduty4x/CoD4x_Server",status:"not-verified"},
  {version:"21.4",releaseVerified:false,source:"callofduty4x/CoD4x_Server",status:"not-verified"},
  {version:"21.5",releaseVerified:false,source:"callofduty4x/CoD4x_Server",status:"not-verified"}
];

const PROMOD_COMPATIBILITY_RULES = [
  {id:"fpschallenge",name:"FPSChallenge Promod",status:"requires-runtime-test"},
  {id:"ebc-pm",name:"eBc Promod",status:"CoD4/CoD4X source-verified"},
  {id:"promod-official",name:"Promod V2",status:"requires-runtime-test"}
];

const FPSCHALLENGE_PROFILES = [
  {id:"fpschallenge",name:"FPSChallenge",source:"https://fpschallenge.eu/",verification:"external-source"},
  {id:"fpschallenge-custom",name:"FPSChallenge Custom",source:"operator supplied",verification:"local"}
];

const EBC_PROMOD_PROFILES = [
  {id:"ebc-pm",name:"eBc Promod",source:"kristiandz/ebc-pm",version:"source/live-server"},
  {id:"promod-official",name:"Promod V2",source:"cod4mw/promod",version:"V2.20 lineage"},
  {id:"custom",name:"Custom Promod",source:"local",version:"operator supplied"}
];

const SERVER_VALIDATION_CHECKS = [
  {id:"files",name:"Server files",description:"CoD4x executable and server directory"},
  {id:"mod",name:"Mod layout",description:"main/mod files and provider manifest"},
  {id:"config",name:"Configuration",description:"server.cfg and required DVARs"},
  {id:"rcon",name:"RCON",description:"endpoint and credential configuration"},
  {id:"ac",name:"Anti-Cheat",description:"selected provider profile"},
  {id:"admin",name:"Admin integration",description:"B3 / IW4MAdmin / Native RCON"}
];

const SERVER_MODULES = [
  {id:"core",name:"CoD4x Core",enabled:true},
  {id:"rcon",name:"RCON Console",enabled:true},
  {id:"players",name:"Player Manager",enabled:true},
  {id:"mods",name:"Mod Manager",enabled:true},
  {id:"anticheat",name:"Anti-Cheat Center",enabled:true},
  {id:"b3",name:"B3 Provider",enabled:true},
  {id:"iw4madmin",name:"IW4MAdmin Provider",enabled:true},
  {id:"backup",name:"Backup & Recovery",enabled:true}
];

const ADMIN_INTEGRATIONS = [
  {id:"b3",name:"BigBrotherBot (B3)",version:"1.10.10 / CoD4X",note:"RCON/log based administration"},
  {id:"raid",name:"RAID Server Admin Tool",version:"RCON adapter",note:"Configurable adapter; no unverified API is hard-coded"},
  {id:"native",name:"Native CoD4x RCON",version:"built-in",note:"Direct RCON"}
];

const ANTICHEAT_PROFILES = [
  {
    id:"fpschallenge",
    name:"FPSChallenge Anti-Cheat (FPSAC)",
    version:"9.2.0",
    note:"FPSChallenge.eu — current published package in the anti-cheat download index"
  },
  {
    id:"cod4x",
    name:"CoD4x Anti-Cheat Settings",
    version:"server",
    note:"CoD4x/server-side anti-cheat hardening profile; no third-party client binary"
  },
  {
    id:"ruscod",
    name:"RusCOD Anti-Cheat Profile",
    version:"community",
    note:"RusCOD community profile; exact anti-cheat package/source must be supplied by the operator"
  },
  {
    id:"none",
    name:"Disabled",
    version:"",
    note:"No anti-cheat integration"
  }
];

const BOT_WARFARE = {
  id: "mods/mp_bots",
  name: "Bot Warfare 2.0.1",
  folder: "mods/mp_bots",
};

const RCON_CMDS = [
  ["status","","Listet verbundene Clients mit Slot, Name und Netzwerkdaten."],
  ["clientkick","<num>","Kick per Client-Slot aus status."],
  ["kick","<name>","Kick per Spielername; bei Sonderzeichen sauber quoten/escapen."],
  ["banClient","<num>","Ban eines Client-Slots."],
  ["banUser","<name>","Ban eines Benutzers/Spielernamens."],
  ["tempBanClient","<num>","Temporärer Ban eines Client-Slots."],
  ["tempBanUser","<name>","Temporärer Ban eines Benutzers."],
  ["unbanuser","<name>","Benutzer-Ban aufheben."],
  ["map","<mapname>","Sofortiger Mapwechsel."],
  ["map_rotate","","Nächsten Eintrag der Rotation laden."],
  ["fast_restart","","Aktuelle Map schnell neu starten."],
  ["map_restart","","Aktuelle Map neu laden."],
  ["say","<text>","Server-Broadcast."],
  ["set","<cvar> <value>","CVar/Dvar setzen."],
  ["get","<cvar>","CVar/Dvar abfragen."],
  ["exec","<config>","CFG ausführen."],
  ["serverinfo","","Öffentliche Serverinformationen ausgeben."],
  ["dumpuser","<num>","Userinfo eines Client-Slots ausgeben."],
  ["users","","Verbundene Benutzer anzeigen."],
  ["rcon_password","<pw>","RCON-Passwort zur Laufzeit ändern."],
  ["g_password","<pw>","Join-Passwort setzen."],
  ["heartbeat","","Heartbeat an den Master-Server senden."],
  ["player","<num>","Erweiterte Spielerinfo für einen Slot (CoD4x)."],
].map(([cmd,args,desc]) => ({cmd,args,desc}));

const DVARS = [
  ["sv_hostname","CoD4 Server","Server","Servername im Browser"],
  ["sv_maxclients","18","Server","Maximale Client-Anzahl."],
  ["sv_password","","Server","Join-Passwort; leer = öffentlich."],
  ["sv_pure","1","Server","Client-Dateiprüfung."],
  ["sv_floodProtect","4","Server","Flood-Protection."],
  ["sv_allowDownload","1","Server","Downloads erlauben."],
  ["sv_maxRate","25000","Server","Maximale Netzwerkrate."],
  ["sv_fps","20","Engine","Server-FPS; Engine-Wert, nicht als frei definierbare Tickrate behandeln."],
  ["sv_timeout","60","Server","Zeitlimit für ausbleibende Client-Nachrichten."],
  ["sv_kickBots","1","Server","Bots bei echten Spielern ggf. entfernen."],
  ["sv_privateClients","0","Server","Reservierte private Client-Slots."],
  ["sv_connectTimeout","30","Server","Timeout beim Verbindungsaufbau."],
  ["sv_mapRotation","","Rotation","Maprotation."],
  ["sv_mapRotationCurrent","","Rotation","Aktueller Rotationsstatus."],
  ["sv_randomMapRotation","0","Rotation","Zufällige Maprotation."],
  ["g_gametype","war","Gameplay","Aktiver Spielmodus."],
  ["g_maxping","0","Gameplay","Maximaler Ping für Join; 0 = unbegrenzt."],
  ["g_allowvote","1","Gameplay","Abstimmungen erlauben."],
  ["g_friendlyfire","2","Gameplay","Teamfeuer-Modus."],
  ["g_deadchat","1","Gameplay","Tote Spieler dürfen chatten."],
  ["g_voicechat","1","Gameplay","Sprachchat."],
  ["g_inactivity","0","Gameplay","Inaktivitätskick in Sekunden; 0 = aus."],
  ["g_spectatormode","1","Gameplay","Zuschauen erlauben."],
  ["g_teamkillpointloss","0","Gameplay","Punktverlust pro Teamkill."],
  ["scr_war_scorelimit","750","Script","Punktlimit TDM."],
  ["scr_war_timelimit","10","Script","Zeitlimit TDM in Minuten."],
  ["scr_sd_scorelimit","1","Script","Zu gewinnende Runden in S&D."],
  ["scr_sd_timelimit","2.5","Script","Rundenzeitlimit S&D."],
  ["scr_sd_roundlimit","15","Script","Maximale Runden S&D."],
  ["scr_sd_bombtimer","45","Script","Bomben-Countdown in Sekunden."],
  ["scr_dom_scorelimit","200","Script","Punktlimit Domination."],
  ["scr_dm_scorelimit","30","Script","Kill-Limit FFA."],
  ["scr_dm_timelimit","10","Script","Zeitlimit FFA."],
  ["scr_koth_scorelimit","250","Script","Punktlimit Headquarters."],
  ["scr_ctf_scorelimit","3","Script","Punktlimit CTF."],
  ["scr_player_respawndelay","0","Script","Respawn-Verzögerung."],
  ["scr_player_sprinttime","4","Script","Sprintdauer."],
  ["scr_game_killstreaks","1","Script","Killstreaks."],
  ["scr_game_perks","1","Script","Perks."],
  ["scr_team_fftype","0","Script","Teamfeuer-Typ für geskriptete Modi."],
  ["net_port","28960","Network","UDP-Port."],
  ["net_ip","0.0.0.0","Network","Bind-Adresse."],
  ["rate","25000","Network","Client-Netzwerkrate."],
  ["fs_game","","FileSystem","Mod-Verzeichnis; leer = Basisspiel."],
  ["fs_basepath",".","FileSystem","Basis-Dateisystempfad."],
  ["developer","0","Developer","Developer-Modus."],
  ["developer_script","0","Developer","Script-Debugging; CVAR_INIT/Startup-Kontext beachten."],
  ["logfile","2","Developer","Log-Modus."],
  ["g_log","games_mp.log","Developer","Log-Dateiname."],
  ["g_logSync","0","Developer","Synchrones Log-Flushen."],,
  ["thereisacow","1337","COD4 Stock / Developer","Classic CoD4 developer unlock variable; not a normal server tuning DVAR."],
  ["g_gravity","800","COD4 Stock / Gameplay","Gravity."],
  ["g_knockback","1000","COD4 Stock / Gameplay","Weapon knockback."],
  ["g_antilag","1","COD4 Stock / Gameplay","Game-side lag compensation toggle."],
  ["g_oldVoting","1","COD4 Stock / Gameplay","Legacy voting behavior."],
  ["g_redCrosshairs","1","COD4 Stock / Gameplay","Red enemy crosshair behavior."],
  ["g_synchronousClients","0","COD4 Stock / Gameplay","Synchronous client mode."],
  ["g_useGear","1","COD4 Stock / Gameplay","Gear usage."],
  ["g_playerCollisionEjectSpeed","25","COD4 Stock / Gameplay","Player collision ejection speed."],
  ["g_compassShowEnemies","0","COD4 Stock / Gameplay","Compass enemy visibility."],
  ["g_voiceChatTalkingDuration","500","COD4 Stock / Gameplay","Voice-chat talking indicator duration."],
  ["g_voteAbstainWeight","0.5","COD4 Stock / Gameplay","Vote abstention weight."],
  ["g_useholdspawndelay","500","COD4 Stock / Gameplay","Hold-spawn delay."],
  ["sv_reconnectlimit","3","COD4 Stock / Server","Reconnect limiting."],
  ["sv_zombietime","2","COD4 Stock / Server","Zombie client timeout."],
  ["sv_privatePassword","","COD4 Stock / Server","Password for private slots."],
  ["sv_master1","cod4master.activision.com","COD4 Stock / Server","Master server endpoint in legacy CoD4."],
  ["snaps","20","COD4 Stock / Network","Snapshot rate."],
  ["cl_maxpackets","100","COD4 Stock / Network","Client packet rate."],
  ["cl_packetdup","1","COD4 Stock / Network","Client packet duplication."],
  ["cl_maxPing","800","COD4 Stock / Network","Client maximum ping preference."],
  ["cl_mouseAccel","0","COD4 Stock / Input","Mouse acceleration."],
  ["sensitivity","5","COD4 Stock / Input","Mouse sensitivity."],
  ["m_pitch","0.022","COD4 Stock / Input","Mouse pitch scale."],
  ["m_yaw","0.022","COD4 Stock / Input","Mouse yaw scale."],
  ["m_filter","0","COD4 Stock / Input","Mouse filtering."],
  ["in_mouse","1","COD4 Stock / Input","Mouse input mode."],
  ["cg_drawFPS","Off","COD4 Stock / HUD","FPS counter."],
  ["cg_drawLagometer","0","COD4 Stock / HUD","Lagometer."],
  ["cg_drawSnapshot","0","COD4 Stock / HUD","Snapshot display."],
  ["cg_drawCrosshair","1","COD4 Stock / HUD","Crosshair visibility."],
  ["cg_crosshairAlpha","1","COD4 Stock / HUD","Crosshair alpha."],
  ["cg_crosshairAlphaMin","0.5","COD4 Stock / HUD","Minimum crosshair alpha."],
  ["cg_crosshairDynamic","0","COD4 Stock / HUD","Dynamic crosshair."],
  ["cg_crosshairEnemyColor","1","COD4 Stock / HUD","Enemy crosshair color behavior."],
  ["cg_drawFriendlyNames","1","COD4 Stock / HUD","Friendly name display."],
  ["cg_drawCrosshairNames","1","COD4 Stock / HUD","Crosshair name display."],
  ["cg_drawTurretCrosshair","1","COD4 Stock / HUD","Turret crosshair."],
  ["cg_cursorHints","4","COD4 Stock / HUD","Context cursor hints."],
  ["cg_chatHeight","8","COD4 Stock / HUD","Chat history height."],
  ["cg_chatTime","12000","COD4 Stock / HUD","Chat display time."],
  ["cg_centerPrintY","-60","COD4 Stock / HUD","Center-print vertical offset."],
  ["cg_blood","1","COD4 Stock / HUD","Blood effects."],
  ["cg_brass","1","COD4 Stock / HUD","Ejected shell casings."],
  ["cg_drawMantleHint","1","COD4 Stock / HUD","Mantle hint."],
  ["cg_drawBreathHint","1","COD4 Stock / HUD","Breath hint."],
  ["cg_descriptiveText","1","COD4 Stock / HUD","Descriptive text."],
  ["cg_connectionIconSize","0","COD4 Stock / HUD","Connection icon size."],
  ["cg_thirdperson","0","COD4 Stock / Camera","Third-person camera."],
  ["cg_thirdpersonrange","120","COD4 Stock / Camera","Third-person camera distance."],
  ["cg_fov","65","COD4 Stock / Camera","Field of view."],
  ["cg_fovscale","1","COD4 Stock / Camera","FOV scale."],
  ["cg_viewsize","100","COD4 Stock / Camera","View size."],
  ["cg_weaponCycleDelay","0","COD4 Stock / Weapon","Weapon cycle delay."],
  ["cg_gun_x","0","COD4 Stock / Weapon","Weapon horizontal offset."],
  ["cg_gun_y","0","COD4 Stock / Weapon","Weapon vertical offset."],
  ["cg_gun_z","0","COD4 Stock / Weapon","Weapon depth offset."],
  ["cg_weaponHintsCoD1","0","COD4 Stock / Weapon","Legacy weapon hint behavior."],
  ["cl_freelook","1","COD4 Stock / Input","Free-look."],
  ["cl_stanceHoldTime","250","COD4 Stock / Input","Stance hold timing."],
  ["cl_bypassMouseInput","0","COD4 Stock / Input","Mouse input bypass."],
  ["cl_voice","1","COD4 Stock / Voice","Voice chat client setting."],
  ["voice_deadChat","0","COD4 Stock / Voice","Dead-chat voice setting."],
  ["voice_global","0","COD4 Stock / Voice","Global voice mode."],
  ["voice_localEcho","0","COD4 Stock / Voice","Local voice echo."],
  ["winvoice_mic_mute","1","COD4 Stock / Voice","Windows microphone mute state."],
  ["winvoice_mic_reclevel","65535","COD4 Stock / Voice","Windows microphone record level."],
  ["winvoice_mic_scaler","1","COD4 Stock / Voice","Windows microphone scaler."],
  ["winvoice_save_voice","0","COD4 Stock / Voice","Save voice setting."],
  ["fs_basegame","","COD4 Stock / FileSystem","Base game directory override."],
  ["fs_cdpath","","COD4 Stock / FileSystem","CD path."],
  ["fs_homepath",".","COD4 Stock / FileSystem","Home path."],
  ["fs_copyfiles","0","COD4 Stock / FileSystem","Filesystem copy mode."],
  ["fs_debug","0","COD4 Stock / FileSystem","Filesystem debugging."],
  ["fs_ignoreLocalized","0","COD4 Stock / FileSystem","Ignore localized assets."],
  ["fs_restrict","0","COD4 Stock / FileSystem","Filesystem restriction."],
  ["r_fullscreen","1","COD4 Stock / Renderer","Fullscreen mode."],
  ["r_mode","800x600","COD4 Stock / Renderer","Display resolution mode."],
  ["r_vsync","0","COD4 Stock / Renderer","Vertical sync."],
  ["r_gamma","1.41","COD4 Stock / Renderer","Gamma."],
  ["r_picmip","0","COD4 Stock / Renderer","Texture mip level."],
  ["r_picmip_bump","0","COD4 Stock / Renderer","Bump-map texture quality."],
  ["r_picmip_spec","0","COD4 Stock / Renderer","Specular texture quality."],
  ["r_picmip_water","0","COD4 Stock / Renderer","Water texture quality."],
  ["r_lodBias","0","COD4 Stock / Renderer","Level-of-detail bias."],
  ["r_lodBiasRigid","0","COD4 Stock / Renderer","Rigid LOD bias."],
  ["r_lodBiasSkinned","0","COD4 Stock / Renderer","Skinned LOD bias."],
  ["r_lodScale","1","COD4 Stock / Renderer","LOD scale."],
  ["r_lodScaleRigid","1","COD4 Stock / Renderer","Rigid LOD scale."],
  ["r_lodScaleSkinned","1","COD4 Stock / Renderer","Skinned LOD scale."],
  ["r_texFilterAnisoMax","4","COD4 Stock / Renderer","Maximum anisotropic filtering."],
  ["r_texFilterAnisoMin","1","COD4 Stock / Renderer","Minimum anisotropic filtering."],
  ["r_texFilterMipMode","Unchanged","COD4 Stock / Renderer","Texture mip filter mode."],
  ["r_normal","1","COD4 Stock / Renderer","Normal mapping."],
  ["r_specular","1","COD4 Stock / Renderer","Specular rendering."],
  ["r_glow","1","COD4 Stock / Renderer","Glow effects."],
  ["r_glow_allowed","1","COD4 Stock / Renderer","Glow allowance."],
  ["r_distortion","1","COD4 Stock / Renderer","Screen distortion."],
  ["r_drawDecals","1","COD4 Stock / Renderer","Decal rendering."],
  ["r_drawSun","1","COD4 Stock / Renderer","Sun rendering."],
  ["r_drawWater","1","COD4 Stock / Renderer","Water rendering."],
  ["r_fastSkin","1","COD4 Stock / Renderer","Fast skinning."],
  ["r_ignorehwgamma","0","COD4 Stock / Renderer","Ignore hardware gamma."],
  ["r_inGameVideo","1","COD4 Stock / Renderer","In-game video."],
  ["r_monitor","0","COD4 Stock / Renderer","Monitor index."],
  ["r_multiGpu","0","COD4 Stock / Renderer","Multi-GPU mode."],
  ["r_polygonOffsetBias","-1","COD4 Stock / Renderer","Polygon offset bias."],
  ["r_polygonOffsetScale","-1","COD4 Stock / Renderer","Polygon offset scale."],
  ["r_preloadShaders","0","COD4 Stock / Renderer","Preload shaders."],
  ["r_rendererPreference","Default","COD4 Stock / Renderer","Renderer preference."],
  ["r_zFeather","0","COD4 Stock / Renderer","Z feathering."],
  ["r_resamplescene","1","COD4 Stock / Renderer","Scene resampling."],
  ["r_sun_from","0","COD4 Stock / Renderer","Sun-flare source setting."],
  ["r_textfilteranisomax","16","COD4 Stock / Renderer","Legacy anisotropic filter maximum."],
  ["r_textfilteranisomin","1","COD4 Stock / Renderer","Legacy anisotropic filter minimum."],
  ["r_textfiltermipmode","3","COD4 Stock / Renderer","Legacy mip filter mode."],
  ["r_uselayeredmaterials","0","COD4 Stock / Renderer","Layered materials."],
  ["ragdoll_enable","0","COD4 Stock / Physics","Ragdoll simulation."],
  ["ragdoll_max_simulating","0","COD4 Stock / Physics","Maximum simultaneous ragdolls."],
  ["phys_gravity","800","COD4 Stock / Physics","Physics gravity."],
  ["friction","5.5","COD4 Stock / Physics","Physics friction."],
  ["dynEnt_active","1","COD4 Stock / Dynamic Entities","Dynamic entities."],
  ["dynEnt_bulletForce","1000","COD4 Stock / Dynamic Entities","Bullet force on dynamic entities."],
  ["dynEnt_explodeForce","12500","COD4 Stock / Dynamic Entities","Explosion force."],
  ["dynEnt_explodeMaxEnts","20","COD4 Stock / Dynamic Entities","Maximum exploding entities."],
  ["dynEnt_explodeMinForce","40","COD4 Stock / Dynamic Entities","Minimum explosion force."],
  ["dynEnt_explodeSpinScale","3","COD4 Stock / Dynamic Entities","Explosion spin scale."],
  ["hud_enable","1","COD4 Stock / HUD","HUD enable."],
  ["hud_fadeout_speed","0.1","COD4 Stock / HUD","HUD fade speed."],
  ["hud_fade_healthbar","2","COD4 Stock / HUD","Health bar fade mode."],
  ["hud_fade_compass","0","COD4 Stock / HUD","Compass fade."],
  ["hud_fade_ammodisplay","0","COD4 Stock / HUD","Ammo display fade."],
  ["hud_fade_offhand","0","COD4 Stock / HUD","Offhand fade."],
  ["hud_fade_sprint","1.7","COD4 Stock / HUD","Sprint fade."],
  ["hud_fade_stance","1.7","COD4 Stock / HUD","Stance fade."],
  ["hud_flash_period_offhand","0.5","COD4 Stock / HUD","Offhand flash period."],
  ["hud_flash_time_offhand","2","COD4 Stock / HUD","Offhand flash duration."],
  ["hud_health_pulserate_critical","0.5","COD4 Stock / HUD","Critical health pulse rate."],
  ["hud_health_pulserate_injured","1","COD4 Stock / HUD","Injured health pulse rate."],
  ["hud_health_startpulse_critical","0.33","COD4 Stock / HUD","Critical health pulse threshold."],
  ["hud_health_startpulse_injured","1","COD4 Stock / HUD","Injured health pulse threshold."],
  ["ui_browserShowDedicated","0","COD4 Stock / UI","Server browser dedicated filter."],
  ["ui_browserShowEmpty","1","COD4 Stock / UI","Show empty servers."],
  ["ui_browserShowFull","0","COD4 Stock / UI","Show full servers."],
  ["ui_browserShowNoPassword","1","COD4 Stock / UI","Show passwordless servers."],
  ["ui_browserShowPassword","-1","COD4 Stock / UI","Password server filter."],
  ["ui_browserShowPure","1","COD4 Stock / UI","Pure server filter."],
  ["ui_browserFriendlyfire","-1","COD4 Stock / UI","Browser friendly-fire filter."],
  ["ui_browserKillcam","-1","COD4 Stock / UI","Browser killcam filter."],
  ["ui_browserMod","0","COD4 Stock / UI","Browser mod filter."],
  ["ui_currentMap","5","COD4 Stock / UI","Current map index."],
  ["ui_currentNetMap","5","COD4 Stock / UI","Current network map index."],
  ["ui_dedicated","0","COD4 Stock / UI","Dedicated server UI state."],
  ["ui_gametype","0","COD4 Stock / UI","Current UI game type."],
  ["ui_joinGametype","3","COD4 Stock / UI","Join game type."],
  ["ui_maxclients","32","COD4 Stock / UI","UI maximum clients."],
  ["ui_netGametype","2","COD4 Stock / UI","Network game type."],
  ["ui_netGametypeName","sd","COD4 Stock / UI","Network game type name."],
  ["ui_netSource","1","COD4 Stock / UI","Network source."],
  ["ui_serverStatusTimeOut","7000","COD4 Stock / UI","Server status timeout."],
  ["ui_smallFont","0.25","COD4 Stock / UI","Small UI font scale."],
  ["ui_bigFont","0.4","COD4 Stock / UI","Big UI font scale."],
  ["ui_extraBigFont","0.55","COD4 Stock / UI","Extra-big UI font scale."],
  ["snd_bits","16","COD4 Stock / Sound","Sound bit depth."],
  ["snd_khz","44","COD4 Stock / Sound","Sound sample rate."],
  ["snd_volume","0.8","COD4 Stock / Sound","Master volume."],
  ["snd_cinematicVolumeScale","0.85","COD4 Stock / Sound","Cinematic volume scale."],
  ["snd_outputConfiguration","Windows default","COD4 Stock / Sound","Audio output configuration."],
  ["snd_levelFadeTime","250","COD4 Stock / Sound","Level fade time."],
  ["snd_slaveFadeTime","500","COD4 Stock / Sound","Slave fade time."],
  ["snd_enableEq","0","COD4 Stock / Sound","Equalizer."],
  ["snd_errorOnMissing","0","COD4 Stock / Sound","Error on missing sound assets."],
  ["snd_touchStreamFilesOnLoad","0","COD4 Stock / Sound","Touch streamed sound files on load."],
  ["com_maxfps","85","COD4 Stock / System","Maximum rendered FPS."],
  ["com_hunkmegs","512","COD4 Stock / System","Hunk memory allocation."],
  ["com_introPlayed","0","COD4 Stock / System","Intro played state."],
  ["sys_cpuGHz","0","COD4 Stock / System","Detected CPU speed."],
  ["sys_gpu","Unknown","COD4 Stock / System","Detected GPU string."],
  ["sys_sysMB","0","COD4 Stock / System","Detected system memory."],
  ["con_showchannel","0","COD4 Stock / Console","Console channel display."],
  ["con_visiblechannellist","0","COD4 Stock / Console","Visible console channel list."],
  ["con_channellist","0","COD4 Stock / Console","Console channel list."],
  ["loc_language","english","COD4 Stock / Localization","Language."],
  ["m_pitch","0.022","COD4 Stock / Input","Mouse pitch."],
  ["m_yaw","0.022","COD4 Stock / Input","Mouse yaw."],
  ["m_forward","0.25","COD4 Stock / Input","Mouse forward scale."],
  ["m_side","0.25","COD4 Stock / Input","Mouse side scale."],
  ["m_filter","0","COD4 Stock / Input","Mouse filtering."],
  ["player_sustainAmmo","0","COD4 Stock / Player","Infinite ammo setting."],
  ["player_sprintUnlimited","0","COD4 Stock / Player","Unlimited sprint setting."],
  ["player_meleeRange","64","COD4 Stock / Player","Melee range."],
  ["player_sprintTime","4","COD4 Stock / Player","Sprint duration."],
  ["player_breathHoldTime","4","COD4 Stock / Player","Breath-hold duration."],
  ["player_strafeAnimCos","0.9","COD4 Stock / Player","Strafe animation cosine parameter."],
  ["player_adsExitDelay","0","COD4 Stock / Player","ADS exit delay."],
  ["aim_autoaim_enabled","1","COD4 Stock / Aim","Autoaim engine toggle."],
  ["aim_autoaim_lerp","40","COD4 Stock / Aim","Autoaim interpolation."],
  ["aim_autoaim_region_width","160","COD4 Stock / Aim","Autoaim region width."],
  ["aim_autoaim_region_height","120","COD4 Stock / Aim","Autoaim region height."],
  ["aim_automelee_enabled","1","COD4 Stock / Aim","Automelee engine toggle."],
  ["aim_automelee_lerp","40","COD4 Stock / Aim","Automelee interpolation."],
  ["aim_automelee_range","128","COD4 Stock / Aim","Automelee range."],
  ["aim_accel_turnrate_enabled","1","COD4 Stock / Aim","Aim turn-rate acceleration."],
  ["aim_accel_turnrate_lerp","1200","COD4 Stock / Aim","Aim acceleration interpolation."]
].map(([name,def,sub,desc]) => ({name,def,sub,desc}));

const QUICK_PROMPTS = [
  "init()-Funktion für einen Custom-Gamemode schreiben",
  "Spieler-Callback mit waittill registrieren",
  "Custom HUD-Element erstellen",
  "Spieler eine spezifische Waffe geben",
  "thread vs. waittillframeend erklären",
  "UAV bei 3 Kills implementieren",
  "Alle Spieler spawnen und Teams balancieren",
  "setClientDvars erklären und Beispiel zeigen",
];

const I18N = {
  de: {
    config:"Server Config", rotation:"Map Rotation", rcon:"RCON Referenz", dvars:"Dvar Browser", gsc:"GSC Assistent", versionManager:"Version Manager", antiCheat:"Anti-Cheat",
    subtitle:"CoD4x 21.5 Admin Panel", configTitle:"Server Config Builder", configSub:"Erzeugt eine server.cfg aus validierten Eingaben",
    identity:"Server Identity", network:"Netzwerk", gameplay:"Gameplay", security:"Sicherheit", logging:"Logging",
    hostname:"sv_hostname", clients:"sv_maxclients", joinPassword:"sv_password", rconPassword:"RCON-Passwort",
    port:"net_port", fps:"sv_fps", maxrate:"sv_maxRate", mod:"Mod / fs_game", customMod:"Benutzerdefinierter Mod-Pfad",
    mode:"g_gametype", friendlyfire:"g_friendlyfire", vote:"g_allowvote", pure:"sv_pure", inactivity:"g_inactivity",
    killstreaks:"scr_game_killstreaks", perks:"scr_game_perks", logfile:"logfile", preview:"server.cfg Preview",
    close:"Schließen", copy:"Kopieren", copied:"✓ kopiert", generated:"→ als server.cfg speichern",
    public:"leer = öffentlich", recommended:"empfohlen", noRcon:"RCON-Passwort ist leer. Für Remote-RCON ein Passwort setzen.",
    rotationTitle:"Map Rotation Builder", rotationSub:"Rotation visuell zusammenstellen und als CFG exportieren",
    maps:"Maps", addHint:"klicken zum Hinzufügen", search:"Suchen…", rotationLabel:"Rotation", entries:"Einträge",
    noMaps:"Keine Maps — links klicken zum Hinzufügen.", inline:"sv_mapRotation", rotationFile:"rotation.cfg",
    rconTitle:"RCON Befehlsreferenz", rconSub:"Dokumentierte Befehlsnamen als lokale Referenz; Verfügbarkeit kann von Build/Mod abhängen.",
    commandSearch:"Befehl oder Beschreibung suchen…", command:"Befehl", args:"Argumente", description:"Beschreibung",
    dvarTitle:"Dvar Browser", dvarSub:"Lokale Referenz der im Panel hinterlegten CoD4x-Dvars.", dvarSearch:"Dvar-Name oder Beschreibung suchen…",
    name:"Name", default:"Default", subsystem:"Subsystem",
    gscTitle:"GSC Script-Assistent", gscSub:"KI-gestützte GSC-Scripting-Hilfe für CoD4x 21.5",
    ask:"GSC-Frage stellen, Code beschreiben oder Fehler einfügen…", send:"Senden", analyzing:"analysiere",
    apiHint:"Der Assistent nutzt /api/gsc. Der Anthropic-API-Key bleibt dadurch im Backend.",
    anticheat:"Anti-Cheat", anticheatProvider:"Anti-Cheat Anbieter", fpsacVersion:"FPSAC Version",
    enforce:"Enforce / Pflicht", autoUpdate:"Auto-Update", screenshots:"Screenshots / Beweissicherung",
    strict:"Strikter CoD4x-Modus", logs:"Anti-Cheat Logging", ruscodMode:"RusCOD Modus",
    ruscodNote:"RusCOD ist als Community-Profil verfügbar. Ein konkretes Anti-Cheat-Paket wird nur installiert, wenn eine verifizierte Quelle angegeben ist.",
    acInstallNote:"FPSChallenge.eu veröffentlicht aktuell FPSAC 9.2.0 sowie FPSCACInstaller.msi/setup.exe. Der Installer lädt nichts von einer unbekannten Quelle.",
    anticheatNote:"Auswahl des Anti-Cheat-Profils. FPSAC 9.2.0 ist im offiziellen FPSChallenge.eu-Downloadindex gelistet.",
    cod4xVersion:"CoD4x Version", fpsVersion:"FPSChallenge.eu Promod Version", botWarfare:"Offline Bot Warfare",
    botWarfareDesc:"LAN/Offline-Bots über Bot Warfare. Die Mod fügt KI-Bots für CoD4-Multiplayer hinzu.",
    botCount:"Bot-Anzahl", botFillMode:"Fill-Modus", botDifficulty:"Bot-Skill", botHost:"First player is host",
    installNote:"Das Panel erzeugt Konfiguration. Mod-Dateien müssen auf Server/Client installiert sein.",
    fpsAc:"FPSChallenge Anti-Cheat", cod4xAc:"CoD4x Anti-Cheat Settings", rusAc:"RUSCOD Anti-Cheat",
    acProvider:"Anti-Cheat System", acMode:"Mode", acStrict:"Strict", acBalanced:"Balanced", acLegacy:"Compatibility",
    acNote:"Anti-Cheat wird nur aktiviert, wenn die benötigten Client-/Server-Komponenten vorhanden sind.",
    versionNote:"Die Auswahl setzt das Zielprofil; sie lädt keine Binärdateien automatisch.",
    fpsVersionNote:"FPS Promod 2.85 ist die aktuelle Version in der geprüften Hosting-Dokumentation.",
    botVersionNote:"Bot Warfare 2.0.1 ist die in der CoD4x-Dokumentation aufgeführte Release-Version.",
    vanilla:"Vanilla / Basisspiel", custom:"Custom", modInstalled:"Mod-Preset",
  },
  en: {
    config:"Server Config", rotation:"Map Rotation", rcon:"RCON Reference", dvars:"Dvar Browser", gsc:"GSC Assistant", versionManager:"Version Manager", antiCheat:"Anti-Cheat",
    subtitle:"CoD4x 21.5 Admin Panel", configTitle:"Server Config Builder", configSub:"Generate a server.cfg from validated inputs",
    identity:"Server Identity", network:"Network", gameplay:"Gameplay", security:"Security", logging:"Logging",
    hostname:"sv_hostname", clients:"sv_maxclients", joinPassword:"sv_password", rconPassword:"RCON password",
    port:"net_port", fps:"sv_fps", maxrate:"sv_maxRate", mod:"Mod / fs_game", customMod:"Custom mod path",
    mode:"g_gametype", friendlyfire:"g_friendlyfire", vote:"g_allowvote", pure:"sv_pure", inactivity:"g_inactivity",
    killstreaks:"scr_game_killstreaks", perks:"scr_game_perks", logfile:"logfile", preview:"server.cfg Preview",
    close:"Close", copy:"Copy", copied:"✓ copied", generated:"→ save as server.cfg",
    public:"empty = public", recommended:"recommended", noRcon:"RCON password is empty. Set one for remote RCON.",
    rotationTitle:"Map Rotation Builder", rotationSub:"Build a rotation visually and export it as CFG",
    maps:"Maps", addHint:"click to add", search:"Search…", rotationLabel:"Rotation", entries:"entries",
    noMaps:"No maps — click a map on the left.", inline:"sv_mapRotation", rotationFile:"rotation.cfg",
    rconTitle:"RCON Command Reference", rconSub:"Local command reference; availability may depend on build/mod.",
    commandSearch:"Search command or description…", command:"Command", args:"Arguments", description:"Description",
    dvarTitle:"Dvar Browser", dvarSub:"Local reference of CoD4x dvars included in this panel.", dvarSearch:"Search dvar or description…",
    name:"Name", default:"Default", subsystem:"Subsystem",
    gscTitle:"GSC Script Assistant", gscSub:"AI-assisted CoD4x 21.5 GSC scripting help",
    ask:"Ask a GSC question, describe code or paste an error…", send:"Send", analyzing:"analyzing",
    apiHint:"The assistant uses /api/gsc. The Anthropic API key stays on the backend.",
    anticheat:"Anti-Cheat", anticheatProvider:"Anti-Cheat provider", fpsacVersion:"FPSAC version",
    enforce:"Enforce / required", autoUpdate:"Auto-update", screenshots:"Screenshots / evidence",
    strict:"Strict CoD4x mode", logs:"Anti-cheat logging", ruscodMode:"RusCOD mode",
    ruscodNote:"RusCOD is exposed as a community profile. A concrete anti-cheat package is installed only when a verified source is supplied.",
    acInstallNote:"FPSChallenge.eu currently publishes FPSAC 9.2.0 plus FPSCACInstaller.msi/setup.exe. The installer never downloads from an unknown source.",
    anticheatNote:"Select the anti-cheat profile. FPSAC 9.2.0 is listed in the official FPSChallenge.eu download index.",
    cod4xVersion:"CoD4x version", fpsVersion:"FPSChallenge.eu Promod version", botWarfare:"Offline Bot Warfare",
    botWarfareDesc:"LAN/offline bots through Bot Warfare. The mod adds AI bots to CoD4 multiplayer.",
    botCount:"Bot count", botFillMode:"Fill mode", botDifficulty:"Bot skill", botHost:"First player is host",
    installNote:"The panel generates configuration. Mod files still need to be installed on server/client.",
    fpsAc:"FPSChallenge Anti-Cheat", cod4xAc:"CoD4x Anti-Cheat Settings", rusAc:"RUSCOD Anti-Cheat",
    acProvider:"Anti-Cheat system", acMode:"Mode", acStrict:"Strict", acBalanced:"Balanced", acLegacy:"Compatibility",
    acNote:"Anti-cheat is enabled only when the required client/server components are present.",
    versionNote:"This sets the target profile; it does not download binaries automatically.",
    fpsVersionNote:"FPS Promod 2.85 is the current version found in the checked hosting documentation.",
    botVersionNote:"Bot Warfare 2.0.1 is the release version listed in the CoD4x documentation.",
    vanilla:"Vanilla / Base game", custom:"Custom", modInstalled:"Mod preset",
  }
};

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const el = document.createElement("textarea");
    el.value = text; el.style.position = "fixed"; el.style.opacity = "0";
    document.body.appendChild(el); el.select();
    try { document.execCommand("copy") ? resolve() : reject(new Error("Clipboard unavailable")); }
    catch (e) { reject(e); } finally { document.body.removeChild(el); }
  });
}

function CopyBtn({ text, t, disabled=false }) {
  const [copied,setCopied] = useState(false);
  const handle = async e => {
    e.stopPropagation();
    if (disabled) return;
    try { await copyText(text); setCopied(true); setTimeout(()=>setCopied(false),1500); }
    catch { setCopied(false); }
  };
  return <button onClick={handle} title={copied?t.copied:t.copy} style={{
    background:copied?"rgba(34,197,94,.15)":C.accentDim, border:`1px solid ${copied?C.success:C.accent+"77"}`,
    color:copied?C.success:C.accent, borderRadius:4, padding:"3px 9px", fontSize:11, cursor:disabled?"not-allowed":"pointer", opacity:disabled?.45:1, fontFamily:"monospace"
  }} disabled={disabled}>{copied?t.copied:t.copy}</button>;
}

function Tag({children,color=C.muted}) {
  return <span style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:4,padding:"2px 7px",fontSize:10,color,whiteSpace:"nowrap"}}>{children}</span>;
}

function SectionHeader({children,sub}) {
  return <div style={{borderLeft:`3px solid ${C.accent}`,paddingLeft:12,marginBottom:20}}>
    <h2 style={{margin:0,color:C.text,fontSize:18,fontWeight:650}}>{children}</h2>
    {sub && <div style={{color:C.muted,fontSize:11,marginTop:4}}>{sub}</div>}
  </div>;
}

function Field({label,children,help}) {
  return <div style={{marginBottom:13}}>
    <label style={{display:"block",color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".08em",marginBottom:5}}>{label}</label>
    {children}
    {help && <div style={{color:C.muted,fontSize:10,marginTop:4}}>{help}</div>}
  </div>;
}

const inputStyle = {width:"100%",boxSizing:"border-box",background:C.surface,border:`1px solid ${C.border}`,color:C.text,borderRadius:6,padding:"8px 11px",fontSize:13,fontFamily:"inherit",outline:"none"};
const selectStyle = {...inputStyle,appearance:"none",cursor:"pointer"};
const buttonStyle = {background:C.surface,border:`1px solid ${C.border}`,color:C.accent,borderRadius:6,padding:"7px 11px",fontSize:11,cursor:"pointer"};

const CFG_CONTROL_RE = /[\u0000-\u001F\u007F]/;
const FS_GAME_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
function cfgTextError(value,label,max=256){
  const raw=String(value??"");
  if(raw.length>max) return `${label}: maximal ${max} Zeichen.`;
  if(CFG_CONTROL_RE.test(raw)) return `${label}: Steuerzeichen oder Zeilenumbrüche sind nicht erlaubt.`;
  return "";
}
function fsGameError(value){
  const raw=String(value??"").trim().replaceAll("\\","/");
  if(!raw) return "";
  if(!raw.startsWith("mods/")) return "Custom Mod Path: nur mods/<name> ist erlaubt.";
  const parts=raw.split("/").slice(1);
  if(!parts.length || parts.some(part=>!part || part===".." || part==="." || !FS_GAME_SEGMENT_RE.test(part))) return "Custom Mod Path: ungültiger mods/<name>-Pfad.";
  return "";
}

function ConfigBuilder({t,lang}) {
  const [cfg,setCfg] = useState({
    sv_hostname:"^1My ^7CoD4x Server",sv_maxclients:"18",sv_password:"",rcon_password:"",
    sv_pure:"1",sv_maxrate:"25000",sv_floodProtect:"4",sv_allowDownload:"1",sv_fps:"20",
    net_port:"28960",g_gametype:"war",g_allowvote:"1",g_friendlyfire:"2",g_inactivity:"0",
    scr_game_killstreaks:"1",scr_game_perks:"1",logfile:"2",g_log:"games_mp.log",fs_game:""
  });
  const [open,setOpen]=useState(false);
  const [showRcon,setShowRcon]=useState(false);
  const [customMod,setCustomMod]=useState("");
  const [modPreset,setModPreset]=useState("");
  const [cod4xVersion,setCod4xVersion]=useState("21.5");
  const [fpsVersion,setFpsVersion]=useState("2.85");
  const [botEnabled,setBotEnabled]=useState(false);
  const [botCount,setBotCount]=useState("10");
  const [botFillMode,setBotFillMode]=useState("0");
  const [botDifficulty,setBotDifficulty]=useState("medium");
  const [botFirstIsHost,setBotFirstIsHost]=useState("1");
  const [anticheat,setAnticheat]=useState("none");
  const [fpsacVersion,setFpsacVersion]=useState("9.2.0");
  const [fpsacEnforce,setFpsacEnforce]=useState(true);
  const [fpsacAutoUpdate,setFpsacAutoUpdate]=useState(false);
  const [fpsacScreenshots,setFpsacScreenshots]=useState(false);
  const [fpschallengeProfile,setFpschallengeProfile]=useState("fpschallenge");
  const [fpschallengeVersion,setFpschallengeVersion]=useState("");
  const [fpschallengeCatalog,setFpschallengeCatalog]=useState([]);
  const [fpschallengeLoading,setFpschallengeLoading]=useState(false);
  const [promodProvider,setPromodProvider]=useState("ebc-pm");
  const [promodInstallMode,setPromodInstallMode]=useState("existing");
  const [promodSourcePath,setPromodSourcePath]=useState("");
  const [adminIntegration,setAdminIntegration]=useState("native-rcon");
  const [b3Prefix,setB3Prefix]=useState("!");
  const [b3LogPath,setB3LogPath]=useState("games_mp.log");
  const [b3AutoBan,setB3AutoBan]=useState(false);
  const [raidEndpoint,setRaidEndpoint]=useState("http://127.0.0.1:8080/api");
  const [raidApiKey,setRaidApiKey]=useState("");
  const [raidLogPath,setRaidLogPath]=useState("games_mp.log");
  const [cod4xAcStrict,setCod4xAcStrict]=useState(false);
  const [cod4xAcLogs,setCod4xAcLogs]=useState(true);
  const [ruscodMode,setRuscodeMode]=useState("balanced");
  const set=(k,v)=>setCfg(x=>({...x,[k]:v}));
  const selectedMod = MODS.find(m=>m.id===modPreset);
  const effectiveMod = botEnabled ? BOT_WARFARE.folder : (customMod.trim() || selectedMod?.folder || "");
  const botDifficultyDvars = {
    easy: "set bots_skill_allies_easy 1\nset bots_skill_axis_easy 1",
    medium: "set bots_skill_allies_med 1\nset bots_skill_axis_med 1",
    hard: "set bots_skill_allies_hard 1\nset bots_skill_axis_hard 1",
    mixed: "set bots_skill_allies_easy 2\nset bots_skill_allies_med 2\nset bots_skill_allies_hard 1\nset bots_skill_axis_easy 2\nset bots_skill_axis_med 2\nset bots_skill_axis_hard 1"
  };

  useEffect(()=>set("fs_game",effectiveMod),[effectiveMod]);

  const errors = [];
  const clients = Number(cfg.sv_maxclients), port=Number(cfg.net_port);
  if (!Number.isInteger(clients) || clients<1 || clients>64) errors.push("sv_maxclients: 1–64");
  if (!Number.isInteger(port) || port<1 || port>65535) errors.push("net_port: 1–65535");
  if (Number(cfg.sv_maxrate)<0) errors.push("sv_maxRate: >= 0");
  if (Number(cfg.g_inactivity)<0) errors.push("g_inactivity: >= 0");
  for (const [value,label,max] of [[cfg.sv_hostname,"Hostname",128],[cfg.sv_password,"Server-Passwort",128],[cfg.g_log,"g_log",128]]) {
    const err=cfgTextError(value,label,max); if(err) errors.push(err);
  }
  const fsErr=fsGameError(effectiveMod); if(fsErr) errors.push(fsErr);

  const generated = errors.length ? "// CFG-Erzeugung blockiert — Eingaben korrigieren.\n// " + errors.join("\n// ") : `// server.cfg — COD4X CONTROL
// ${new Date().toLocaleDateString(lang==="de"?"de-DE":"en-US")}

set sv_hostname "${cfg.sv_hostname.replaceAll('"','\\"')}"
set sv_maxclients ${cfg.sv_maxclients}
${cfg.sv_password ? `set sv_password "${cfg.sv_password.replaceAll('"','\\"')}"` : "// sv_password leer — öffentlicher Server"}
${cfg.fs_game ? `set fs_game "${cfg.fs_game.replaceAll('"','\\"')}"` : "// fs_game leer — Basisspiel"}
// Anti-cheat profile: ${anticheat}${anticheat==="fpschallenge" ? ` / FPSAC ${fpsacVersion}` : ""}
// FPSChallenge FPSAC client/server integration is selected in the control panel.
// Do not invent unsupported CoD4x DVARs; CoD4x hardening is represented as a profile.
// RusCOD is represented as a community profile unless a verified package is supplied.
${anticheat==="fpschallenge" ? `// FPSAC enforce=${fpsacEnforce?1:0} auto_update=${fpsacAutoUpdate?1:0} screenshots=${fpsacScreenshots?1:0}` : ""}
${anticheat==="cod4x" ? `// CoD4x AC strict=${cod4xAcStrict?1:0} logs=${cod4xAcLogs?1:0}` : ""}
${anticheat==="ruscod" ? `// RusCOD AC mode=${ruscodMode}` : ""}
// Target profile: CoD4x ${cod4xVersion}${fpsVersion !== "custom" ? ` / FPS Promod ${fpsVersion}` : " / FPS Promod custom"}${botEnabled ? " / Offline Bot Warfare" : ""}

${botEnabled ? `
// Offline Bot Warfare
set bots_main 1
set bots_main_firstIsHost ${botFirstIsHost}
set bots_main_menu 1
set bots_manage_fill ${botCount}
set bots_manage_fill_mode ${botFillMode}
set bots_manage_fill_kick 1
set bots_play_move 1
set bots_play_fire 1
set bots_play_ads 1
set bots_play_obj 1
set bots_play_killstreak 1
${botDifficultyDvars[botDifficulty]}
` : ""}

set net_port ${cfg.net_port}
set sv_fps ${cfg.sv_fps}
set sv_maxRate ${cfg.sv_maxrate}
set sv_allowDownload ${cfg.sv_allowDownload}
set sv_floodProtect ${cfg.sv_floodProtect}
set sv_pure ${cfg.sv_pure}

set g_gametype ${cfg.g_gametype}
set g_allowvote ${cfg.g_allowvote}
set g_friendlyfire ${cfg.g_friendlyfire}
set g_inactivity ${cfg.g_inactivity}
set scr_game_killstreaks ${cfg.scr_game_killstreaks}
set scr_game_perks ${cfg.scr_game_perks}

set logfile ${cfg.logfile}
set g_log "${cfg.g_log}"
`;

  const cfgValid = errors.length === 0;

  return <div>
    <SectionHeader sub={t.configSub}>{t.configTitle}</SectionHeader>
    {!String(cfg.rcon_password||"").trim() && <div style={{background:"rgba(239,68,68,.1)",border:`1px solid ${C.danger}44`,borderRadius:6,padding:"9px 12px",marginBottom:16,fontSize:12,color:C.danger}}>
      ⚠ {t.noRcon}
    </div>}
    {errors.length>0 && <div style={{background:"rgba(239,68,68,.08)",border:`1px solid ${C.danger}55`,borderRadius:6,padding:"9px 12px",marginBottom:16,fontSize:11,color:C.danger}}>
      {errors.join(" · ")}
    </div>}

    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:28}}>
      <div>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:12}}>{t.identity}</div>
        <Field label={t.hostname}><input style={inputStyle} value={cfg.sv_hostname} onChange={e=>set("sv_hostname",e.target.value)}/></Field>
        <Field label={t.clients}><input style={inputStyle} type="number" min="1" max="64" value={cfg.sv_maxclients} onChange={e=>set("sv_maxclients",e.target.value)}/></Field>
        <Field label={t.joinPassword} help={t.public}><input type="password" style={inputStyle} value={cfg.sv_password} onChange={e=>set("sv_password",e.target.value)}/></Field>
        <Field label={t.rconPassword}>
          <div style={{display:"flex",gap:6}}><input type={showRcon?"text":"password"} autoComplete="new-password" spellCheck={false} style={{...inputStyle,flex:1}} value={cfg.rcon_password} onChange={e=>set("rcon_password",e.target.value)} placeholder="••••••••"/>
          <button onClick={()=>setShowRcon(x=>!x)} style={{...inputStyle,width:70,cursor:"pointer"}}>{showRcon?"Hide":"Show"}</button></div>
        </Field>

        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",margin:"20px 0 12px"}}>Mod</div>
        <Field label={t.mod}>
          <select style={selectStyle} value={modPreset} onChange={e=>{setModPreset(e.target.value);setCustomMod("");setBotEnabled(false);}}>
            {MODS.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label={t.customMod} help="Beispiel: mods/pml220_custom">
          <input style={inputStyle} value={customMod} onChange={e=>{setCustomMod(e.target.value);setModPreset("");setBotEnabled(false);}} placeholder="mods/my_mod"/>
        </Field>
        <Field label={t.anticheatProvider || "Anti-Cheat"}>
          <select style={selectStyle} value={anticheat} onChange={e=>setAnticheat(e.target.value)}>
            {ANTICHEAT_PROFILES.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {anticheat==="fpschallenge" && <Field label={t.fpsacVersion || "FPSAC Version"}>
          <select style={selectStyle} value={fpsacVersion} onChange={e=>setFpsacVersion(e.target.value)}>
            <option value="9.2.0">9.2.0</option>
          </select>
        </Field>}
        <div style={{marginBottom:10,display:"flex",gap:6,flexWrap:"wrap"}}>
          <Tag color={C.blue}>CoD4x {cod4xVersion}</Tag>
          <Tag color={C.accent}>{fpsVersion==="custom"?"FPS Promod Custom":`FPS Promod ${fpsVersion}`}</Tag>
          <Tag color={botEnabled?C.success:C.muted}>{botEnabled?"Bot Warfare":"No Bot Warfare"}</Tag>
          <Tag color={effectiveMod?C.success:C.muted}>{effectiveMod || t.vanilla}</Tag>
        </div>
      </div>

      <div>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:12}}>{t.compatibility || "Compatibility"}</div>
        <Field label={t.cod4xVersion} help={t.versionNote}>
          <select style={selectStyle} value={cod4xVersion} onChange={e=>setCod4xVersion(e.target.value)}>
            {COD4X_VERSIONS.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label={t.fpsVersion} help={t.fpsVersionNote}>
          <select style={selectStyle} value={fpsVersion} onChange={e=>setFpsVersion(e.target.value)}>
            {FPS_PROMOD_VERSIONS.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,background:C.accentDim,border:`1px solid ${C.accent}33`,borderRadius:8,padding:"10px 12px",marginBottom:14}}>
          <div>
            <div style={{color:C.text,fontSize:12,fontWeight:650}}>{t.botWarfare}</div>
            <div style={{color:C.muted,fontSize:10,marginTop:3}}>{t.botWarfareDesc}</div>
          </div>
          <button onClick={()=>{setBotEnabled(x=>!x);setModPreset("");setCustomMod("");}}
            style={{background:botEnabled?C.accent:C.surface,border:`1px solid ${botEnabled?C.accent:C.border}`,color:botEnabled?"#000":C.muted,borderRadius:6,padding:"7px 11px",cursor:"pointer",fontSize:11,fontWeight:700}}>
            {botEnabled?"ON":"OFF"}
          </button>
        </div>

        {botEnabled && <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:18}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10}}>
            <Field label={t.botCount}><input style={inputStyle} type="number" min="0" max="63" value={botCount} onChange={e=>setBotCount(e.target.value)}/></Field>
            <Field label={t.botFillMode}><select style={selectStyle} value={botFillMode} onChange={e=>setBotFillMode(e.target.value)}><option value="0">0 — Players + Bots</option><option value="1">1 — Bots only</option></select></Field>
            <Field label={t.botDifficulty}><select style={selectStyle} value={botDifficulty} onChange={e=>setBotDifficulty(e.target.value)}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option><option value="mixed">Mixed</option></select></Field>
            <Field label={t.botHost}><select style={selectStyle} value={botFirstIsHost} onChange={e=>setBotFirstIsHost(e.target.value)}><option value="1">1 — On</option><option value="0">0 — Off</option></select></Field>
          </div>
          <div style={{color:C.muted,fontSize:10,lineHeight:1.6}}>{t.botVersionNote} {t.installNote}</div>
        </div>}


      <div style={{marginBottom:20}}>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:12}}>FPSChallenge profile</div>
        <Field label="FPSChallenge distribution">
          <select style={selectStyle} value={fpschallengeProfile} onChange={e=>setFpschallengeProfile(e.target.value)}>
            {FPSCHALLENGE_PROFILES.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="FPSChallenge version">
          <select style={selectStyle} value={fpschallengeVersion} onChange={e=>setFpschallengeVersion(e.target.value)}>
            <option value="">Load catalog…</option>
            {fpschallengeCatalog.map(v=><option key={v.id} value={v.id}>{v.name}{v.variant?" — "+v.variant:""}</option>)}
          </select>
        </Field>
        <button style={buttonStyle} disabled={fpschallengeLoading} onClick={async()=>{
          setFpschallengeLoading(true);
          try{
            const r=await apiFetch(apiUrl("/api/fpschallenge/catalog"));
            const d=await r.json();
            setFpschallengeCatalog(d.versions||[]);
          }finally{setFpschallengeLoading(false);}
        }}>{fpschallengeLoading?"Loading…":"Load FPSChallenge download catalog"}</button>
        <div style={{color:C.muted,fontSize:10,lineHeight:1.5,marginTop:8}}>
          Catalog source: dl.fpschallenge.eu/cod4/mods/. Versions are discovered from the server directory listing.
        </div>
      </div>

      <div style={{marginBottom:20}}>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:12}}>eBc Promod Provider</div>
        <Field label="Promod distribution">
          <select style={selectStyle} value={promodProvider} onChange={e=>setPromodProvider(e.target.value)}>
            {EBC_PROMOD_PROFILES.map(p=><option key={p.id} value={p.id}>{p.name} — {p.version}</option>)}
          </select>
        </Field>
        <Field label="Install mode">
          <select style={selectStyle} value={promodInstallMode} onChange={e=>setPromodInstallMode(e.target.value)}>
            <option value="copy-source">Copy verified local source</option>
            <option value="git-clone">Git clone during install</option>
            <option value="existing">Use existing server mod</option>
          </select>
        </Field>
        <Field label="Local source path (optional)">
          <input style={inputStyle} value={promodSourcePath} onChange={e=>setPromodSourcePath(e.target.value)} placeholder="C:\Sources\ebc-pm"/>
        </Field>
        <div style={{color:C.muted,fontSize:10,lineHeight:1.5}}>
          eBc Promod is the Explicit Bouncers Promod repository and is documented as ready for live CoD4/CoD4X servers.
        </div>
      </div>

      <div>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:12}}>Server Admin Integration</div>
        <Field label="Admin Framework">
          <select style={selectStyle} value={adminIntegration} onChange={e=>setAdminIntegration(e.target.value)}>
            {ADMIN_INTEGRATIONS.map(a=><option key={a.id} value={a.id}>{a.name} — {a.version}</option>)}
          </select>
        </Field>
        {adminIntegration==="b3" && <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:14}}>
          <Field label="B3 command prefix"><input style={inputStyle} value={b3Prefix} maxLength={3} onChange={e=>setB3Prefix(e.target.value)}/></Field>
          <Field label="Game log"><input style={inputStyle} value={b3LogPath} onChange={e=>setB3LogPath(e.target.value)}/></Field>
          <label style={{display:"flex",gap:8,alignItems:"center",fontSize:11,color:C.text}}>
            <input type="checkbox" checked={b3AutoBan} onChange={e=>setB3AutoBan(e.target.checked)}/>Automatic B3 ban enforcement
          </label>
        </div>}
        {adminIntegration==="raid" && <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:14}}>
          <Field label="RAID endpoint"><input style={inputStyle} placeholder="http://127.0.0.1:PORT/api" value={raidEndpoint} onChange={e=>setRaidEndpoint(e.target.value)}/></Field>
          <Field label="RAID API key"><input type="password" style={inputStyle} value={raidApiKey} onChange={e=>setRaidApiKey(e.target.value)} autoComplete="off"/></Field>
          <Field label="Game log"><input style={inputStyle} value={raidLogPath} onChange={e=>setRaidLogPath(e.target.value)}/></Field>
          <div style={{color:C.muted,fontSize:10,lineHeight:1.5}}>RAID is an adapter. No undocumented API or command syntax is assumed.</div>
        </div>}
      </div>

      <div>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:12}}>{t.anticheat}</div>
        <Field label={t.anticheatProvider} help={t.anticheatNote}>
          <select style={selectStyle} value={anticheat} onChange={e=>setAnticheat(e.target.value)}>
            {ANTICHEAT_PROFILES.map(a=><option key={a.id} value={a.id}>{a.name}{a.version?` ${a.version}`:""}</option>)}
          </select>
        </Field>

        {anticheat==="fpschallenge" && <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:14}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10}}>
            <Field label={t.fpsacVersion}>
              <select style={selectStyle} value={fpsacVersion} onChange={e=>setFpsacVersion(e.target.value)}>
                <option value="9.2.0">FPSAC 9.2.0</option>
              </select>
            </Field>
            <label style={{display:"flex",gap:8,alignItems:"center",fontSize:11,color:C.text}}>
              <input type="checkbox" checked={fpsacEnforce} onChange={e=>setFpsacEnforce(e.target.checked)}/>{t.enforce}
            </label>
            <label style={{display:"flex",gap:8,alignItems:"center",fontSize:11,color:C.text}}>
              <input type="checkbox" checked={fpsacAutoUpdate} onChange={e=>setFpsacAutoUpdate(e.target.checked)}/>{t.autoUpdate}
            </label>
            <label style={{display:"flex",gap:8,alignItems:"center",fontSize:11,color:C.text}}>
              <input type="checkbox" checked={fpsacScreenshots} onChange={e=>setFpsacScreenshots(e.target.checked)}/>{t.screenshots}
            </label>
          </div>
        </div>}

        {anticheat==="cod4x" && <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:14}}>
          <label style={{display:"flex",gap:8,alignItems:"center",fontSize:11,color:C.text,marginBottom:8}}>
            <input type="checkbox" checked={cod4xAcStrict} onChange={e=>setCod4xAcStrict(e.target.checked)}/>{t.strict}
          </label>
          <label style={{display:"flex",gap:8,alignItems:"center",fontSize:11,color:C.text}}>
            <input type="checkbox" checked={cod4xAcLogs} onChange={e=>setCod4xAcLogs(e.target.checked)}/>{t.logs}
          </label>
        </div>}

        {anticheat==="ruscod" && <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:14}}>
          <Field label={t.ruscodMode}>
            <select style={selectStyle} value={ruscodMode} onChange={e=>setRuscodeMode(e.target.value)}>
              <option value="profile">RusCOD profile only</option>
              <option value="manual">Manual package / config</option>
            </select>
          </Field>
          <div style={{color:C.muted,fontSize:10,lineHeight:1.5}}>{t.ruscodNote}</div>
        </div>}

        <div style={{color:C.muted,fontSize:10,lineHeight:1.5,marginBottom:18}}>
          {t.acInstallNote}
        </div>
      </div>

      <div>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:12}}>{t.network}</div>
        <Field label={t.port}><input style={inputStyle} type="number" min="1" max="65535" value={cfg.net_port} onChange={e=>set("net_port",e.target.value)}/></Field>
        <Field label={t.fps} help="Engine-FPS; nicht mit einer frei konfigurierbaren Netzwerk-Tickrate gleichsetzen."><input style={inputStyle} type="number" value={cfg.sv_fps} onChange={e=>set("sv_fps",e.target.value)}/></Field>
        <Field label={t.maxrate}><input style={inputStyle} type="number" min="0" value={cfg.sv_maxrate} onChange={e=>set("sv_maxrate",e.target.value)}/></Field>

        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",margin:"20px 0 12px"}}>{t.gameplay}</div>
        <Field label={t.mode}><select style={selectStyle} value={cfg.g_gametype} onChange={e=>set("g_gametype",e.target.value)}>{MODES.map(m=><option key={m.id} value={m.id}>{m.id} — {m.name}</option>)}</select></Field>
        <Field label={t.friendlyfire}><select style={selectStyle} value={cfg.g_friendlyfire} onChange={e=>set("g_friendlyfire",e.target.value)}>{["0 — Off","1 — On","2 — Reflect","3 — Shared"].map((x,i)=><option key={i} value={i}>{x}</option>)}</select></Field>
        <Field label={t.vote}><select style={selectStyle} value={cfg.g_allowvote} onChange={e=>set("g_allowvote",e.target.value)}><option value="1">1 — On</option><option value="0">0 — Off</option></select></Field>
        <Field label={t.pure}><select style={selectStyle} value={cfg.sv_pure} onChange={e=>set("sv_pure",e.target.value)}><option value="1">1 — On</option><option value="0">0 — Off</option></select></Field>
        <Field label={t.inactivity}><input style={inputStyle} type="number" min="0" value={cfg.g_inactivity} onChange={e=>set("g_inactivity",e.target.value)}/></Field>
        <Field label={t.killstreaks}><select style={selectStyle} value={cfg.scr_game_killstreaks} onChange={e=>set("scr_game_killstreaks",e.target.value)}><option value="1">1 — On</option><option value="0">0 — Off</option></select></Field>
        <Field label={t.perks}><select style={selectStyle} value={cfg.scr_game_perks} onChange={e=>set("scr_game_perks",e.target.value)}><option value="1">1 — On</option><option value="0">0 — Off</option></select></Field>

        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",margin:"20px 0 12px"}}>{t.logging}</div>
        <Field label={t.logfile}><select style={selectStyle} value={cfg.logfile} onChange={e=>set("logfile",e.target.value)}><option value="0">0 — Off</option><option value="1">1 — Buffered</option><option value="2">2 — Line buffered</option></select></Field>
        <Field label="g_log"><input style={inputStyle} value={cfg.g_log} onChange={e=>set("g_log",e.target.value)}/></Field>
      </div>
    </div>

    <div style={{display:"flex",gap:10,marginTop:8,alignItems:"center",flexWrap:"wrap"}}>
      <button onClick={()=>cfgValid && setOpen(x=>!x)} disabled={!cfgValid} style={{background:C.accentDim,border:`1px solid ${C.accent}55`,color:C.accent,borderRadius:6,padding:"8px 15px",cursor:cfgValid?"pointer":"not-allowed",opacity:cfgValid?1:.45,fontSize:13}}>
        {open?"▲ "+t.close:"▼ "+t.preview}
      </button>
      <CopyBtn text={generated} t={t} disabled={!cfgValid}/>
      <span style={{color:cfgValid?C.muted:C.danger,fontSize:11}}>{cfgValid?t.generated:"CFG blockiert – Eingaben korrigieren"}</span>
    </div>
    {open && <pre style={{marginTop:14,background:C.code,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 18px",overflow:"auto",fontSize:12,color:"#9fc5e8",fontFamily:"monospace",lineHeight:1.7,maxHeight:420}}>{generated}</pre>}
  </div>
  </div>;
}

function MapRotationBuilder({t}) {
  const [rotation,setRotation]=useState([{map:"mp_crash",mode:"war"},{map:"mp_crossfire",mode:"war"},{map:"mp_backlot",mode:"sd"},{map:"mp_overgrown",mode:"dom"}]);
  const [search,setSearch]=useState(""),[defMode,setDefMode]=useState("war"),[previewType,setPreviewType]=useState("inline");
  const filtered=MAPS.filter(m=>m.name.toLowerCase().includes(search.toLowerCase())||m.id.includes(search.toLowerCase()));
  const addMap=m=>setRotation(r=>[...r,{map:m.id,mode:defMode}]);
  const move=(i,d)=>setRotation(r=>{const j=i+d;if(j<0||j>=r.length)return r;const n=[...r];[n[i],n[j]]=[n[j],n[i]];return n;});
  const inline=`set sv_mapRotation "${rotation.map(e=>`gametype ${e.mode} map ${e.map}`).join(" ")}"`;
  const fileOut=rotation.map((e,i)=>`// Slot ${i+1}: ${MAPS.find(m=>m.id===e.map)?.name||e.map}\ngametype ${e.mode}\nmap ${e.map}`).join("\n\n");
  return <div>
    <SectionHeader sub={t.rotationSub}>{t.rotationTitle}</SectionHeader>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:24}}>
      <div><div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:10}}>{t.maps} ({t.addHint})</div>
        <div style={{display:"flex",gap:8,marginBottom:10}}><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t.search} style={{...inputStyle,flex:1}}/><select value={defMode} onChange={e=>setDefMode(e.target.value)} style={{...selectStyle,width:95}}>{MODES.map(m=><option key={m.id} value={m.id}>{m.id}</option>)}</select></div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,maxHeight:390,overflow:"auto"}}>{filtered.map(m=>{const count=rotation.filter(x=>x.map===m.id).length;return <button key={m.id} onClick={()=>addMap(m)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 12px",background:"transparent",border:0,borderBottom:`1px solid ${C.border}`,color:C.text,cursor:"pointer",textAlign:"left"}}><span><span style={{display:"block",fontSize:13}}>{m.name}</span><span style={{color:C.muted,fontSize:10,fontFamily:"monospace"}}>{m.id}</span></span><span style={{display:"flex",gap:6,alignItems:"center"}}>{count>0&&<Tag color={C.accent}>{count}×</Tag>}<b style={{color:C.accent,fontSize:18}}>+</b></span></button>})}</div>
      </div>
      <div><div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:10}}>{t.rotation} — {rotation.length} {t.entries}</div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,maxHeight:430,overflow:"auto"}}>{rotation.length===0?<div style={{padding:28,color:C.muted,textAlign:"center"}}>{t.noMaps}</div>:rotation.map((e,i)=><div key={`${e.map}-${i}`} style={{display:"flex",alignItems:"center",gap:7,padding:"7px 10px",borderBottom:`1px solid ${C.border}`}}>
          <span style={{color:C.muted,fontSize:10,minWidth:18,textAlign:"right"}}>{i+1}</span><div style={{flex:1,minWidth:0}}><div style={{color:C.text,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{MAPS.find(m=>m.id===e.map)?.name||e.map}</div><div style={{color:C.muted,fontSize:10,fontFamily:"monospace"}}>{e.map}</div></div>
          <select value={e.mode} onChange={ev=>setRotation(r=>r.map((x,j)=>j===i?{...x,mode:ev.target.value}:x))} style={{background:C.card,border:`1px solid ${C.border}`,color:C.accent,borderRadius:4,padding:"3px 5px",fontSize:11}}>{MODES.map(m=><option key={m.id} value={m.id}>{m.id}</option>)}</select>
          <button onClick={()=>move(i,-1)} style={iconBtn}>▲</button><button onClick={()=>move(i,1)} style={iconBtn}>▼</button><button onClick={()=>setRotation(r=>r.filter((_,j)=>j!==i))} style={{...iconBtn,color:C.danger}}>✕</button>
        </div>)}</div>
      </div>
    </div>
    <div style={{marginTop:18}}><div style={{display:"flex",gap:8,marginBottom:10,alignItems:"center",flexWrap:"wrap"}}>
      <div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden"}}>{["inline","datei"].map(x=><button key={x} onClick={()=>setPreviewType(x)} style={{background:previewType===x?C.accentDim:C.surface,border:0,color:previewType===x?C.accent:C.muted,padding:"6px 12px",cursor:"pointer"}}>{x==="inline"?t.inline:t.rotationFile}</button>)}</div>
      <CopyBtn text={previewType==="inline"?inline:fileOut} t={t}/>
    </div><pre style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 16px",fontSize:11,color:"#9fc5e8",fontFamily:"monospace",overflow:"auto",maxHeight:220,lineHeight:1.7}}>{previewType==="inline"?inline:fileOut}</pre></div>
  </div>;
}

const iconBtn={background:"none",border:0,color:C.muted,cursor:"pointer",padding:"3px",fontSize:12};

function RCONCommands({t}) {
  const [search,setSearch]=useState("");
  const filtered=RCON_CMDS.filter(c=>c.cmd.toLowerCase().includes(search.toLowerCase())||c.desc.toLowerCase().includes(search.toLowerCase()));
  return <div><SectionHeader sub={t.rconSub}>{t.rconTitle}</SectionHeader><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t.commandSearch} style={{...inputStyle,marginBottom:14}}/>
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
      <div style={{display:"grid",gridTemplateColumns:"150px 170px 1fr 70px",padding:"8px 12px",borderBottom:`1px solid ${C.border}`,color:C.muted,fontSize:10,textTransform:"uppercase"}}><span>{t.command}</span><span>{t.args}</span><span>{t.description}</span><span/></div>
      <div style={{maxHeight:520,overflow:"auto"}}>{filtered.map(c=><div key={c.cmd} style={{display:"grid",gridTemplateColumns:"150px 170px 1fr 70px",padding:"9px 12px",borderBottom:`1px solid ${C.border}`,alignItems:"center"}}><span style={{fontFamily:"monospace",color:C.accent,fontSize:12}}>{c.cmd}</span><span style={{fontFamily:"monospace",color:C.blue,fontSize:11}}>{c.args||"—"}</span><span style={{color:C.text,fontSize:12}}>{c.desc}</span><CopyBtn text={c.cmd+(c.args?" "+c.args:"")} t={t}/></div>)}</div>
    </div>
  </div>;
}

function DvarBrowser({t}) {
  const [search,setSearch]=useState(""),[sub,setSub]=useState("Alle");
  const subs=["Alle",...new Set(DVARS.map(d=>d.sub))];
  const filtered=DVARS.filter(d=>(sub==="Alle"||d.sub===sub)&&(d.name.toLowerCase().includes(search.toLowerCase())||d.desc.toLowerCase().includes(search.toLowerCase())));
  return <div><SectionHeader sub={t.dvarSub}>{t.dvarTitle}</SectionHeader><div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:"8px 11px",fontSize:11,color:C.muted,marginBottom:10}}>
      COD4 Stock-DVAR-Katalog: dokumentierte Legacy-CoD4-DVARs sind enthalten. Client-, Developer- und Server-DVARs werden getrennt gekennzeichnet; nicht jede Legacy-DVAR ist in CoD4x 21.5 serverseitig verfügbar.
    </div><div style={{display:"flex",gap:10,marginBottom:12}}><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t.dvarSearch} style={{...inputStyle,flex:1}}/></div>
    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>{subs.map(s=><button key={s} onClick={()=>setSub(s)} style={{background:sub===s?C.accentDim:C.surface,border:`1px solid ${sub===s?C.accent:C.border}`,color:sub===s?C.accent:C.muted,borderRadius:6,padding:"5px 11px",fontSize:11,cursor:"pointer"}}>{s}</button>)}</div>
    <div style={{color:C.muted,fontSize:11,marginBottom:8}}>{filtered.length} Dvars</div>
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
      <div style={{overflowX:"auto"}}>
        <div style={{minWidth:900}}>
          <div style={{display:"grid",gridTemplateColumns:"190px 90px 205px minmax(360px,1fr)",padding:"7px 12px",borderBottom:`1px solid ${C.border}`,background:C.code,color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".07em",position:"sticky",top:0,zIndex:2}}>
            <span>{t.name}</span><span>{t.default}</span><span>{t.subsystem}</span><span>{t.description}</span>
          </div>
          <div style={{maxHeight:520,overflowY:"auto"}}>
            {filtered.map((d,i)=><div key={`${d.name}-${i}`} style={{display:"grid",gridTemplateColumns:"190px 90px 205px minmax(360px,1fr)",padding:"6px 12px",minHeight:34,borderBottom:`1px solid ${C.border}`,alignItems:"center",background:i%2===0?"transparent":"rgba(255,255,255,.012)"}}>
              <span style={{fontFamily:"monospace",color:C.accent,fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",paddingRight:10}}>{d.name}</span>
              <span style={{fontFamily:"monospace",color:C.blue,fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",paddingRight:10}}>{d.def||'""'}</span>
              <span style={{minWidth:0,paddingRight:14,overflow:"hidden"}}><span style={{display:"inline-block",maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",verticalAlign:"middle"}}><Tag>{d.sub}</Tag></span></span>
              <span style={{color:C.text,fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",minWidth:0}} title={d.desc}>{d.desc}</span>
            </div>)}
          </div>
        </div>
      </div>
    </div>
  </div>;
}

function MsgContent({content,t}) {
  return <>{content.split(/(```[\s\S]*?```)/g).map((part,i)=>part.startsWith("```")?
    <div key={i} style={{position:"relative",margin:"6px 0"}}><pre style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:6,padding:"10px 12px",overflow:"auto",fontSize:12,color:"#9fc5e8",margin:0,fontFamily:"monospace",lineHeight:1.65}}>{part.replace(/^```\w*\n?/,"").replace(/```$/,"")}</pre><div style={{position:"absolute",top:6,right:8}}><CopyBtn text={part.replace(/^```\w*\n?/,"").replace(/```$/,"")} t={t}/></div></div>
    :<span key={i} style={{whiteSpace:"pre-wrap"}}>{part}</span>)}</>;
}

function GSCAssistant({t,lang}) {
  const [messages,setMessages]=useState([{role:"assistant",content:lang==="de"?"Hallo! Ich bin dein CoD4x 21.5 GSC-Assistent. Stelle eine Frage oder füge Code/Fehler ein.":"Hello! I am your CoD4x 21.5 GSC assistant. Ask a question or paste code/an error."}]);
  const [input,setInput]=useState(""),[loading,setLoading]=useState(false),[error,setError]=useState("");
  const bottomRef=useRef(null),inputRef=useRef(null),abortRef=useRef(null);
  useEffect(()=>bottomRef.current?.scrollIntoView({behavior:"smooth"}),[messages,loading]);
  useEffect(()=>()=>abortRef.current?.abort(),[]);
  const send=async override=>{
    const text=(override??input).trim(); if(!text||loading)return;
    setInput("");setError("");const next=[...messages,{role:"user",content:text}];setMessages(next);setLoading(true);
    const controller=new AbortController();abortRef.current=controller;
    try{
      const res=await apiFetch(apiUrl("/api/gsc"),{method:"POST",headers:{"Content-Type":"application/json"},signal:controller.signal,
        body:JSON.stringify({language:lang,messages:next.slice(1).map(m=>({role:m.role,content:m.content}))})});
      const data=await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(data?.error?.message||data?.error||`HTTP ${res.status}`);
      const reply=data.content?.[0]?.text||data.reply||"Keine Antwort erhalten.";
      setMessages(m=>[...m,{role:"assistant",content:reply}]);
    }catch(err){
      if(err.name!=="AbortError"){setError(err.message);setMessages(m=>[...m,{role:"assistant",content:`❌ ${lang==="de"?"API-Fehler":"API error"}: ${err.message}`}]);}
    }finally{setLoading(false);setTimeout(()=>inputRef.current?.focus(),50);}
  };
  return <div style={{display:"flex",flexDirection:"column",minHeight:"calc(100vh - 110px)"}}>
    <SectionHeader sub={t.gscSub}>{t.gscTitle}</SectionHeader>
    <div style={{background:C.accentDim,border:`1px solid ${C.accent}33`,borderRadius:6,padding:"8px 11px",fontSize:11,color:C.muted,marginBottom:12}}>{t.apiHint}</div>
    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>{QUICK_PROMPTS.map((p,i)=><button key={i} onClick={()=>send(p)} style={{background:C.surface,border:`1px solid ${C.border}`,color:C.muted,borderRadius:6,padding:"5px 9px",fontSize:11,cursor:"pointer"}}>{p.length>48?p.slice(0,48)+"…":p}</button>)}</div>
    <div style={{flex:1,minHeight:360,overflow:"auto",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:14,display:"flex",flexDirection:"column",gap:10}}>
      {messages.map((m,i)=><div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}><div style={{maxWidth:"88%",background:m.role==="user"?C.accentDim:C.card,border:`1px solid ${m.role==="user"?C.accent+"33":C.border}`,borderRadius:8,padding:"9px 13px",color:C.text,fontSize:13,lineHeight:1.7}}><MsgContent content={m.content} t={t}/></div></div>)}
      {loading&&<div style={{color:C.muted,fontFamily:"monospace",fontSize:12}}>{t.analyzing}...</div>}<div ref={bottomRef}/>
    </div>
    {error&&<div style={{color:C.danger,fontSize:11,marginTop:7}}>{error}</div>}
    <div style={{display:"flex",gap:10,marginTop:10}}><input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}} placeholder={t.ask} style={{...inputStyle,flex:1,padding:"10px 14px"}}/><button onClick={()=>send()} disabled={loading||!input.trim()} style={{background:loading||!input.trim()?C.surface:C.accent,border:`1px solid ${loading||!input.trim()?C.border:C.accent}`,color:loading||!input.trim()?C.muted:"#000",borderRadius:8,padding:"10px 22px",fontSize:13,fontWeight:700,cursor:loading||!input.trim()?"not-allowed":"pointer"}}>{t.send} ↵</button></div>
  </div>;
}


function UpdateManager({t,lang,cod4xVersion}) {
  const [checking,setChecking]=useState(false);
  const [result,setResult]=useState(null);
  const [checkedAt,setCheckedAt]=useState("");

  async function checkUpdates(){
    setChecking(true); setResult(null);
    try{
      const endpoints=[
        ["server","CoD4x Server","https://api.github.com/repos/callofduty4x/CoD4x_Server/releases/latest"],
        ["client","CoD4x Client","https://api.github.com/repos/callofduty4x/CoD4x_Client_pub/releases/latest"]
      ];
      const rows=await Promise.all(endpoints.map(async ([id,label,url])=>{
        const r=await fetch(url,{headers:{Accept:"application/vnd.github+json"}});
        if(!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
        const d=await r.json();
        return {id,label,tag:d.tag_name||"unknown",name:d.name||d.tag_name||"Release",url:d.html_url||"",published:d.published_at||""};
      }));
      setResult({rows});
      setCheckedAt(new Date().toLocaleString(lang==="de"?"de-DE":"en-US"));
    }catch(e){
      setResult({error:e.message});
      setCheckedAt(new Date().toLocaleString(lang==="de"?"de-DE":"en-US"));
    }finally{setChecking(false);}
  }

  return <Section title={lang==="de"?"Update Manager":"Update Manager"}>
    <div style={{display:"flex",justifyContent:"space-between",gap:14,alignItems:"center",flexWrap:"wrap",marginBottom:14}}>
      <div>
        <div style={{fontSize:12,color:C.text,fontWeight:650}}>{lang==="de"?"Offizielle Release-Prüfung":"Official release check"}</div>
        <div style={{fontSize:10,color:C.muted,marginTop:4}}>
          {lang==="de"?"Prüft nur offizielle GitHub-Releases. Es wird nichts automatisch installiert.":"Checks official GitHub releases only. Nothing is installed automatically."}
        </div>
      </div>
      <button onClick={checkUpdates} disabled={checking} style={{...buttonStyle,opacity:checking?.65:1}}>
        {checking?(lang==="de"?"Prüfe…":"Checking…"):(lang==="de"?"Nach Updates suchen":"Check for updates")}
      </button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10}}>
      <div style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:6,padding:12}}>
        <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:".08em"}}>{lang==="de"?"Ausgewähltes Profil":"Selected profile"}</div>
        <div style={{fontFamily:"monospace",fontSize:14,color:C.accent,marginTop:6}}>CoD4x {cod4xVersion}</div>
      </div>
      {(result?.rows||[]).map(r=><div key={r.id} style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:6,padding:12}}>
        <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:".08em"}}>{r.label}</div>
        <div style={{fontFamily:"monospace",fontSize:14,color:C.success,marginTop:6}}>{r.tag}</div>
        {r.published&&<div style={{fontSize:10,color:C.muted,marginTop:5}}>{new Date(r.published).toLocaleDateString(lang==="de"?"de-DE":"en-US")}</div>}
        {r.url&&<a href={r.url} target="_blank" rel="noreferrer" style={{display:"inline-block",marginTop:7,color:C.accent,fontSize:10}}>GitHub Release ↗</a>}
      </div>)}
    </div>
    {result?.error&&<div style={{marginTop:10,padding:9,border:`1px solid ${C.danger}55`,background:"rgba(239,68,68,.07)",borderRadius:6,color:C.danger,fontSize:11}}>{result.error}</div>}
    {checkedAt&&<div style={{fontSize:9,color:C.muted,marginTop:10}}>{lang==="de"?"Letzte Prüfung:":"Last check:"} {checkedAt}</div>}
  </Section>;
}

function VersionManager({t,lang}) {
  const [cod4x,setCod4x]=useState("21.5");
  const [fps,setFps]=useState("2.85");
  const [mod,setMod]=useState("");
  const [path,setPath]=useState("./server");
  const [dryRun,setDryRun]=useState(true);
  const [log,setLog]=useState([]);
  const [busy,setBusy]=useState(false);
  const [antiCheat,setAntiCheat]=useState("none");
  const [acMode,setAcMode]=useState("balanced");
  const [availability,setAvailability]=useState(null);

  useEffect(()=>{
    let cancelled=false;
    apiFetch(apiUrl("/api/installer/releases")).then(r=>r.ok?r.json():null).then(d=>{if(!cancelled)setAvailability(d)}).catch(()=>{});
    return ()=>{cancelled=true};
  },[]);

  const compatibilityStatus = useMemo(()=>{
    if(fps==="custom") return "LOCAL_CUSTOM";
    if(fps==="2.85" && cod4x==="21.5") return "SUPPORTED_CUSTOM_CLIENT";
    return "VERSION_UNVERIFIED";
  },[fps,cod4x]);

  const profile = useMemo(()=>({
    cod4x,
    fps,
    mod: mod || "vanilla",
    antiCheat,
    acMode,
    path,
  }),[cod4x,fps,mod,path,antiCheat,acMode]);

  async function runInstall() {
    setBusy(true);
    setLog([]);
    try {
      const res = await apiFetch(apiUrl("/api/installer"), {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"prepare",dryRun,profile})
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setLog(data.log || [lang==="de"?"Profil vorbereitet.":"Profile prepared."]);
    } catch(e) {
      setLog([`❌ ${e.message}`]);
    } finally { setBusy(false); }
  }

  const manifest = `# COD4X CONTROL install profile
cod4x=${cod4x}
fps_promod=${fps}
mod=${mod || "vanilla"}
server_path=${path}
dry_run=${dryRun ? "true" : "false"}`;

  return <div>
    <SectionHeader sub={lang==="de"?"Versionen, Profile und Installationsziel verwalten":"Manage versions, profiles and installation target"}>
      {t.versionManager}
    </SectionHeader>

    <UpdateManager t={t} lang={lang} cod4xVersion={cod4x}/>

    <div style={{background:"rgba(245,158,11,.07)",border:`1px solid ${C.accent}33`,borderRadius:8,padding:12,marginBottom:18,fontSize:12,color:C.muted,lineHeight:1.6}}>
      {lang==="de"
        ? "Der Manager trennt Auswahl und Installation. FPS Promod 2.85 wird direkt vom FPSChallenge.eu-Downloadserver bezogen. Für den benutzerdefinierten CoD4x-21.5-Client wird die Quelle separat behandelt; es werden keine fremden oder erfundenen Binärdateien installiert."
        : "The manager separates selection and installation. FPS Promod 2.85 is sourced directly from the FPSChallenge.eu download server. The custom CoD4x 21.5 client is handled as a separate source; no invented or unrelated binaries are installed."}
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:20}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:16}}>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:14}}>
          {lang==="de"?"Version & Mod Profil":"Version & Mod profile"}
        </div>
        <Field label={t.cod4xVersion}>
          <select style={selectStyle} value={cod4x} onChange={e=>setCod4x(e.target.value)}>
            {COD4X_VERSIONS.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label={t.fpsVersion}>
          <select style={selectStyle} value={fps} onChange={e=>setFps(e.target.value)}>
            {FPS_PROMOD_VERSIONS.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label={lang==="de"?"Mod":"Mod"}>
          <select style={selectStyle} value={mod} onChange={e=>setMod(e.target.value)}>
            <option value="">Vanilla / Basisspiel</option>
            {MODS.filter(m=>m.id).map(m=><option key={m.id} value={m.folder}>{m.name}</option>)}
            <option value={BOT_WARFARE.folder}>{BOT_WARFARE.name}</option>
          </select>
        </Field>
        <Field label={t.anticheatProvider || "Anti-Cheat"}>
          <select style={selectStyle} value={antiCheat} onChange={e=>setAntiCheat(e.target.value)}>
            {ANTICHEAT_PROFILES.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t.acMode || "Mode"}>
          <select style={selectStyle} value={acMode} onChange={e=>setAcMode(e.target.value)}>
            <option value="strict">{t.acStrict || "Strict"}</option>
            <option value="balanced">{t.acBalanced || "Balanced"}</option>
            <option value="legacy">{t.acLegacy || "Compatibility"}</option>
          </select>
        </Field>
        <Field label={lang==="de"?"Server-Verzeichnis":"Server directory"}>
          <input style={inputStyle} value={path} onChange={e=>setPath(e.target.value)} placeholder="./server"/>
        </Field>
        <label style={{display:"flex",gap:8,alignItems:"center",fontSize:12,color:C.text,cursor:"pointer",marginTop:5}}>
          <input type="checkbox" checked={dryRun} onChange={e=>setDryRun(e.target.checked)}/>
          {lang==="de"?"Dry-Run / nichts ändern":"Dry-run / change nothing"}
        </label>
      </div>

      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:16}}>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:14}}>
          {lang==="de"?"Aktuelles Profil":"Current profile"}
        </div>
        <div style={{display:"grid",gap:9}}>
          <div><Tag color={C.blue}>CoD4x {cod4x}</Tag></div>
          {availability?.fpsPromod && <div><Tag color={availability.fpsPromod.available?C.success:C.muted}>
            FPSChallenge.eu 2.85 {availability.fpsPromod.available ? "✓" : "— unavailable"}
          </Tag></div>}
          <div><Tag color={C.accent}>FPS Promod {fps==="custom"?"Custom":fps}</Tag></div>
          <div><Tag color={mod?C.success:C.muted}>{mod || "Vanilla"}</Tag></div>
          <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,wordBreak:"break-all"}}>{path}</div>
        </div>

        <div style={{display:"flex",gap:8,marginTop:18,flexWrap:"wrap"}}>
          <button onClick={runInstall} disabled={busy} style={{background:busy?C.surface:C.accent,border:`1px solid ${busy?C.border:C.accent}`,color:busy?C.muted:"#000",borderRadius:6,padding:"9px 14px",fontWeight:700,cursor:busy?"wait":"pointer"}}>
            {busy ? "..." : (lang==="de"?"Profil an Backend senden":"Send profile to backend")}
          </button>
          <CopyBtn text={manifest} t={t}/>
        </div>
      </div>
    </div>

    <div style={{marginTop:20}}>
      <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",letterSpacing:".09em",marginBottom:8}}>
        {lang==="de"?"Installer-Log":"Installer log"}
      </div>
      <pre style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:8,padding:14,minHeight:110,color:"#9fc5e8",fontSize:11,fontFamily:"monospace",whiteSpace:"pre-wrap"}}>
        {log.length ? log.join("\n") : (lang==="de"?"Noch kein Installationslauf.":"No installation run yet.")}
      </pre>
    </div>
  </div>;
}

function DiagnosticsPanel({t,lang}){
  const [cod4x,setCod4x]=useState("21.5");
  const [fps,setFps]=useState("2.85");
  const [mod,setMod]=useState("");
  const [path,setPath]=useState("./server");
  const [rconHost,setRconHost]=useState("127.0.0.1");
  const [rconPort,setRconPort]=useState("28960");
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState(null);

  async function runDiagnostics(){
    setBusy(true); setResult(null);
    try{
      const qs=new URLSearchParams({cod4x,fps,mod,path,rconHost,rconPort});
      const r=await apiFetch(apiUrl(`/api/diagnostics?${qs.toString()}`));
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setResult(d);
    }catch(e){setResult({status:"degraded",checks:[],error:e.message});}
    finally{setBusy(false);}
  }

  const statusColor=result?.status==="healthy"?C.success:result?C.danger:C.muted;
  const statusLabel=result?.status==="healthy"?(lang==="de"?"HEALTHY":"HEALTHY"):(lang==="de"?"DEGRADED":"DEGRADED");
  const icon=s=>s==="pass"?"✓":s==="warn"?"!":"×";
  const color=s=>s==="pass"?C.success:s==="warn"?C.accent:C.danger;

  return <div>
    <SectionHeader sub={lang==="de"?"Zentrale Prüfung von Version, Zielpfad, Core, Konfiguration, Modulen, RCON und Netzwerk":"Central validation of version, target path, core, configuration, modules, RCON and network"}>
      {lang==="de"?"Diagnostics & Health Monitor":"Diagnostics & Health Monitor"}
    </SectionHeader>
    <Section title={lang==="de"?"Prüfprofil":"Diagnostic profile"}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
        <Field label={t.cod4xVersion}><select style={selectStyle} value={cod4x} onChange={e=>setCod4x(e.target.value)}>{COD4X_VERSIONS.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
        <Field label={t.fpsVersion}><select style={selectStyle} value={fps} onChange={e=>setFps(e.target.value)}>{FPS_PROMOD_VERSIONS.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
        <Field label={lang==="de"?"Mod":"Mod"}><select style={selectStyle} value={mod} onChange={e=>setMod(e.target.value)}><option value="">Vanilla / Basisspiel</option>{MODS.filter(m=>m.id).map(m=><option key={m.id} value={m.folder}>{m.name}</option>)}</select></Field>
        <Field label={lang==="de"?"Server-Verzeichnis":"Server directory"}><input style={inputStyle} value={path} onChange={e=>setPath(e.target.value)} placeholder="./server" /></Field>
        <Field label="RCON Host"><input style={inputStyle} value={rconHost} onChange={e=>setRconHost(e.target.value)} /></Field>
        <Field label="RCON Port"><input style={inputStyle} value={rconPort} onChange={e=>setRconPort(e.target.value)} inputMode="numeric" /></Field>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",marginTop:4}}>
        <div style={{fontSize:10,color:C.muted}}>{lang==="de"?"Die Prüfung ist lesend; Dateien werden nicht verändert.":"Diagnostics are read-only; no files are modified."}</div>
        <button onClick={runDiagnostics} disabled={busy} style={{...buttonStyle,opacity:busy?.65:1}}>{busy?(lang==="de"?"Prüfe…":"Checking…"):(lang==="de"?"Diagnose starten":"Run diagnostics")}</button>
      </div>
    </Section>

    {result&&<>
      <Section title={lang==="de"?"Gesamtstatus":"Overall status"}>
        <div style={{display:"flex",alignItems:"center",gap:10}}><span style={{width:10,height:10,borderRadius:"50%",background:statusColor,display:"inline-block"}}/><span style={{fontFamily:"monospace",fontWeight:700,color:statusColor}}>{statusLabel}</span><span style={{fontSize:10,color:C.muted}}>{result.checks.length} {lang==="de"?"Prüfungen":"checks"}</span></div>
        {result.error&&<div style={{marginTop:10,color:C.danger,fontSize:11}}>{result.error}</div>}
      </Section>
      <Section title={lang==="de"?"Einzelprüfungen":"Checks"}>
        <div style={{display:"grid",gap:7}}>{result.checks.map(c=><div key={c.id} style={{display:"grid",gridTemplateColumns:"24px minmax(160px,220px) 1fr",gap:8,alignItems:"center",background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"8px 10px"}}><span style={{color:color(c.status),fontWeight:800,textAlign:"center"}}>{icon(c.status)}</span><span style={{fontSize:11,color:C.text}}>{c.label}</span><span style={{fontSize:10,color:C.muted,wordBreak:"break-word"}}>{c.detail}</span></div>)}</div>
      </Section>
    </>}
  </div>;
}

function ServerInstancesPanel({lang,executablePath,baseGamePath,platform,cod4x}){
  const de=lang==="de";
  const [hostPlatform,setHostPlatform]=useState(null);
  const [instances,setInstances]=useState([]),[id,setId]=useState("public-01"),[name,setName]=useState("Public 01"),[port,setPort]=useState(28960),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const generation=useRef(0);
  async function load(){const request=++generation.current;try{const r=await apiFetch(apiUrl("/api/instances"));const data=await r.json();if(request!==generation.current)return;if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);setInstances(data.instances||[]);setHostPlatform(data.hostPlatform||null)}catch(e){if(request===generation.current)setError(e.message)}}
  useEffect(()=>{load();const timer=setInterval(load,3000);return()=>{clearInterval(timer);generation.current++}},[]);
  async function request(route,method,body){setBusy(true);setError("");setMessage("");try{const r=await apiFetch(apiUrl(route),{method,headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);setMessage(data.archive?(de?`Instanz archiviert; wiederherstellbar unter ${data.archive.archivedHomePath}`:`Instance archived; recoverable at ${data.archive.archivedHomePath}`):(de?"Instanzvorgang abgeschlossen.":"Instance operation completed."));await load()}catch(e){setError(e.message)}finally{setBusy(false)}}
  const definition={id,name,port:Number(port),platform,serverCore:{executablePath,version:cod4x},basePath:baseGamePath};
  return <Section title={de?"Serverinstanzen · getrennte Homepaths":"Server instances · isolated homes"}>
    <div style={{color:C.muted,fontSize:11,marginBottom:10}}>{de?"Neue Instanzen verwenden den unten ausgewählten Core und die BaseGame. Jede Instanz erhält eigene Konfiguration, Logs und einen eigenen UDP-Port. Lokale Starts binden an 127.0.0.1; bestandene isolierte Tests sind keine vollständige Releasefreigabe.":"New instances use the Core and BaseGame selected below. Each instance has separate configuration, logs and a UDP port. Local starts bind to 127.0.0.1; passing isolated tests does not constitute a full release approval."}</div>
    {error&&<div role="alert" style={{color:C.danger,marginBottom:8}}>{error}</div>}
    {message&&<div role="status" style={{color:C.success,marginBottom:8}}>{message}</div>}
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
      <label>{de?"Server-ID":"Server ID"}<input style={inputStyle} value={id} onChange={e=>setId(e.target.value)} disabled={busy}/></label>
      <label>{de?"Name":"Name"}<input style={inputStyle} value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></label>
      <label>UDP-Port<input type="number" min="1024" max="65535" style={inputStyle} value={port} onChange={e=>setPort(e.target.value)} disabled={busy}/></label>
      <button style={buttonStyle} disabled={busy||!executablePath||!baseGamePath} onClick={()=>request("/api/instances","POST",definition)}>{de?"Neu erstellen":"Create"}</button>
    </div>
    {instances.length===0&&<div style={{color:C.muted}}>{de?"Noch keine verwalteten Instanzen. Die bisherige Einzel-Runtime bleibt separat erhalten.":"No managed instances yet. Legacy single runtime remains separate."}</div>}
    {instances.map(instance=>{const state=instance.runtime?.status||"UNKNOWN",active=["STARTING","RUNNING","STOPPING"].includes(state)||Boolean(instance.runtime?.pid);return <div key={instance.id} style={{border:`1px solid ${C.border}`,borderRadius:6,padding:10,marginBottom:8}}>
      <div><strong>{instance.name}</strong> · {instance.id} · UDP {instance.port} · {state} · PID {instance.runtime?.pid||"—"}</div>
      <div style={{fontSize:11,wordBreak:"break-all",color:C.muted}}>fs_homepath: {instance.homePath}<br/>fs_basepath: {instance.basePath}<br/>{de?"Konfiguration":"Configuration"}: {instance.configPath}</div>
      {(instance.inspectionError||instance.runtime?.lastError)&&<div style={{color:C.danger,fontSize:11}}>{instance.inspectionError||instance.runtime.lastError}</div>}
      <RuntimePersistenceWarning runtime={instance.runtime} de={de} style={{color:C.danger,fontSize:11,marginTop:8,wordBreak:"break-word"}} />
      <InstanceConfigEditor instance={instance} de={de} request={(route, options)=>apiFetch(apiUrl(route),options)} />
      <InstanceCredentialEditor instance={instance} de={de} request={(route, options)=>apiFetch(apiUrl(route),options)} />
      <InstanceRconConsole instance={instance} de={de} request={(route, options)=>apiFetch(apiUrl(route),options)} />
      <InstanceMasterStatus instance={instance} de={de} request={(route, options)=>apiFetch(apiUrl(route),options)} />
      <InstancePluginManager instance={instance} de={de} request={(route, options)=>apiFetch(apiUrl(route),options)} />
      <InstanceB3Runtime instance={instance} de={de} request={(route, options)=>apiFetch(apiUrl(route),options)} />
      <InstanceB3Database instance={instance} de={de} request={(route, options)=>apiFetch(apiUrl(route),options)} />
      <InstanceB3Admin instance={instance} de={de} request={(route, options)=>apiFetch(apiUrl(route),options)} />
      <div style={{display:"flex",gap:7,flexWrap:"wrap",marginTop:8}}>
        <button style={buttonStyle} disabled={busy||active||instance.platform!==hostPlatform} onClick={()=>request(`/api/instances/${instance.id}/start`,"POST")}>Start</button>
        <button style={buttonStyle} disabled={busy||!active} onClick={()=>request(`/api/instances/${instance.id}/stop`,"POST")}>Stop</button>
        <button style={buttonStyle} disabled={busy||state!=="RUNNING"} onClick={()=>request(`/api/instances/${instance.id}/restart`,"POST")}>Restart</button>
        <button style={buttonStyle} disabled={busy||!id||id===instance.id} onClick={()=>request(`/api/instances/${instance.id}/clone`,"POST",{id,name,port:Number(port)})}>{de?"Als neue ID duplizieren":"Clone to new ID"}</button>
        <button style={buttonStyle} disabled={busy||active} onClick={()=>{if(window.confirm(de?`Instanz ${instance.id} aus der Liste entfernen und ihren Ordner wiederherstellbar archivieren?`:`Remove ${instance.id} and archive its directory recoverably?`))request(`/api/instances/${instance.id}`,"DELETE")}}>{de?"Löschen / archivieren":"Delete / archive"}</button>
      </div>
      <details style={{marginTop:8}}><summary>{de?"Instanz-Ausgabe":"Instance output"}</summary><pre style={{maxHeight:180,overflow:"auto",fontSize:10,whiteSpace:"pre-wrap"}}>{instance.runtime?.output?.stdout||""}{instance.runtime?.output?.stderr||""}</pre></details>
      <details style={{marginTop:8}}><summary>{de?"Windows-Konsolenlog":"Windows console log"} · qconsole.log · {instance.consoleLog?.status||"waiting"}</summary><pre style={{maxHeight:240,overflow:"auto",fontSize:10,whiteSpace:"pre-wrap"}}>{instance.consoleLog?.text||""}</pre>{instance.consoleLog?.truncated&&<small>{de?"Nur die letzten 64 KiB; unvollständige Zeilen ausgelassen.":"Last 64 KiB only; incomplete lines omitted."}</small>}</details>
    </div>})}
  </Section>
}

function ProductionRuntimePanel({lang}){
  const [runtime,setRuntime]=useState(null),[preflight,setPreflight]=useState(null),[path,setPath]=useState("./server"),[baseGamePath,setBaseGamePath]=useState(""),[executablePath,setExecutablePath]=useState(""),[platform,setPlatform]=useState("windows"),[cod4x,setCod4x]=useState("21.5"),[busy,setBusy]=useState(false),[searching,setSearching]=useState(false),[candidates,setCandidates]=useState([]),[error,setError]=useState(""),[message,setMessage]=useState("");
  const loadGeneration=useRef(0);
  const de=lang==="de";
  const load=async()=>{const generation=++loadGeneration.current;try{const q=`/api/runtime/preflight?path=${encodeURIComponent(path)}&executablePath=${encodeURIComponent(executablePath)}&platform=${encodeURIComponent(platform)}&cod4x=${encodeURIComponent(cod4x)}&baseGamePath=${encodeURIComponent(baseGamePath)}`;const [sr,pr]=await Promise.all([apiFetch(apiUrl("/api/runtime/status")),apiFetch(apiUrl(q))]);const sd=await sr.json().catch(()=>({}));const pd=await pr.json().catch(()=>({}));if(generation!==loadGeneration.current)return;if(!sr.ok)throw new Error(sd?.error||`HTTP ${sr.status}`);setRuntime(sd.runtime);setPreflight(pd);if(sd.runtime?.baseGamePath&&!baseGamePath)setBaseGamePath(sd.runtime.baseGamePath);if(sd.runtime?.target&&path==="./server")setPath(sd.runtime.target);if(sd.runtime?.executablePath&&!executablePath)setExecutablePath(sd.runtime.executablePath);if(sd.runtime?.cod4x&&cod4x==="21.5")setCod4x(sd.runtime.cod4x);if(sd.runtime?.platform&&platform==="windows")setPlatform(sd.runtime.platform)}catch(e){setError(e.message)}};
  useEffect(()=>{load();const id=setInterval(load,2500);return()=>{clearInterval(id);loadGeneration.current++}},[path,executablePath,platform,cod4x,baseGamePath]);
  async function saveConfig(nextPath=path,nextExecutable=executablePath,nextPlatform=platform,nextCod4x=cod4x){setBusy(true);setError("");try{const r=await apiFetch(apiUrl("/api/runtime/config"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:nextPath,executablePath:nextExecutable,platform:nextPlatform,cod4x:nextCod4x,baseGamePath})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||`HTTP ${r.status}`);setRuntime(d.runtime);setMessage(de?"Runtime-Konfiguration gespeichert.":"Runtime configuration saved.");await load()}catch(e){setError(e.message)}finally{setBusy(false)}}
  async function action(kind){setBusy(true);setError("");setMessage("");try{const r=await apiFetch(apiUrl(`/api/runtime/${kind}`),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path,executablePath,platform,cod4x,baseGamePath})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||`HTTP ${r.status}`);setRuntime(d.runtime);setMessage(kind==="start"?(de?"Runtime gestartet.":"Runtime started."):kind==="stop"?(de?"Runtime gestoppt.":"Runtime stopped."):(de?"Runtime neu gestartet.":"Runtime restarted."));await load()}catch(e){setError(e.message);await load()}finally{setBusy(false)}}
  async function adopt(){setBusy(true);setError("");setMessage("");try{const r=await apiFetch(apiUrl("/api/runtime/adopt"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path,executablePath,platform,cod4x,baseGamePath})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||`HTTP ${r.status}`);if(d.runtime?.executablePath)setExecutablePath(d.runtime.executablePath);setRuntime(d.runtime);setMessage(de?"Dedicated-Server-Core übernommen und verifiziert.":"Dedicated server core adopted and verified.");await load()}catch(e){setError(e.message);await load()}finally{setBusy(false)}}
  async function chooseFolder(){if(state==="RUNNING")return;try{const selected=window.cod4xControl?.selectFolder?await window.cod4xControl.selectFolder():null;if(selected){setPath(selected);setMessage(de?"Server-Verzeichnis übernommen.":"Server directory selected.")}}catch(e){setError(e.message||String(e))}}
  async function chooseExecutable(){if(state==="RUNNING")return;try{const selected=window.cod4xControl?.selectExecutable?await window.cod4xControl.selectExecutable():null;if(selected){setExecutablePath(selected);setMessage(de?"Dedicated-Server-Core ausgewählt.":"Dedicated server core selected.")}}catch(e){setError(e.message||String(e))}}
  async function useCandidate(candidate){const candidatePlatform=candidate.platform||platform;setExecutablePath(candidate.executable);setPlatform(candidatePlatform);setCandidates([]);setMessage(de?"Gefundener Dedicated-Core ausgewählt und gespeichert.":"Selected and saved dedicated server core.");try{await saveConfig(path,candidate.executable,candidatePlatform,cod4x)}catch{}}
  async function searchCores(){setSearching(true);setError("");setMessage("");setCandidates([]);try{const r=await apiFetch(apiUrl("/api/runtime/search"));const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||`HTTP ${r.status}`);setCandidates(d.candidates||[]);setMessage((d.candidates||[]).length?(de?`${d.candidates.length} Dedicated-Core(s) gefunden.`:`${d.candidates.length} dedicated server core(s) found.`):(de?"Kein CoD4X Dedicated Server Core gefunden.":"No CoD4X dedicated server core found."))}catch(e){setError(e.message)}finally{setSearching(false)}}
  const state=runtime?.status||"UNKNOWN",stateColor=state==="RUNNING"?C.success:state==="FAILED"?C.danger:C.muted,coreOk=preflight?.core?.verified===true,baseGameOk=preflight?.baseGame?.valid===true;
  return <>
    <Header
      title={de ? "Production Runtime" : "Production Runtime"}
      sub={de ? "4.18.12 · Windows / Linux Dedicated Runtime · Config Engine · RCON · Master List · Plugins · B3 Manager · B3 Database" : "4.18.12 · Windows / Linux Dedicated Runtime · Config Engine · RCON · Master List · Plugins · B3 Manager · B3 Database"}
    />

    <ServerInstancesPanel lang={lang} executablePath={executablePath} baseGamePath={baseGamePath} platform={platform} cod4x={cod4x}/>
    <Section title={de ? "B3 / eBc-B3" : "B3 / eBc-B3"}><B3DependencyPanel de={de} request={(route, options)=>apiFetch(apiUrl(route),options)}/></Section>
    <Section title={de ? "Bisherige Einzel-Runtime (Kompatibilität)" : "Legacy single runtime (compatibility)"}>
      {error && (
        <div style={{background:"rgba(239,68,68,.1)",border:`1px solid ${C.danger}55`,color:C.danger,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:10}}>
          {error}
        </div>
      )}
      {message && (
        <div style={{background:"rgba(34,197,94,.08)",border:`1px solid ${C.success}55`,color:C.success,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:10}}>
          {message}
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1.5fr .8fr .7fr",gap:12}}>
        <Field
          label={de ? "Server-Verzeichnis" : "Server directory"}
          help={de ? "Instanz-Datenverzeichnis (fs_homepath); das OS-Arbeitsverzeichnis ist das Core-Verzeichnis." : "Instance data directory (fs_homepath); the OS working directory is the Core directory."}
        >
          <div style={{display:"flex",gap:7}}>
            <input
              style={{...inputStyle,flex:1}}
              value={path}
              onChange={e=>setPath(e.target.value)}
              disabled={state==="RUNNING"}
              placeholder={de ? "z.B. C:\\Games\\CoD4X\\Server" : "e.g. C:\\Games\\CoD4X\\Server"}
            />
            <button onClick={chooseFolder} disabled={busy || state==="RUNNING"} style={buttonStyle}>
              {de ? "Durchsuchen" : "Browse"}
            </button>
          </div>
        </Field>

        <Field label={de ? "Server-Plattform" : "Server platform"}>
          <select style={selectStyle} value={platform} onChange={e=>{setPlatform(e.target.value);setExecutablePath("")}} disabled={state==="RUNNING"}>
            <option value="windows">Windows · cod4x18_dedrun.exe</option>
            <option value="linux">Linux · cod4x18_dedrun</option>
          </select>
        </Field>

        <Field label="CoD4x">
          <select style={selectStyle} value={cod4x} onChange={e=>setCod4x(e.target.value)} disabled={state==="RUNNING"}>
            {["21.5","21.4","21.3","21.2"].map(v=><option key={v}>{v}</option>)}
          </select>
        </Field>
      </div>

      <Field label={de ? "BaseGame-Verzeichnis" : "BaseGame directory"} help={de ? "Gemeinsamer Spielbestand mit main/*.iwd und zone/*; wird nur gelesen." : "Shared game assets with main/*.iwd and zone/*; read-only source."}>
        <input style={inputStyle} value={baseGamePath} onChange={e=>setBaseGamePath(e.target.value)} disabled={busy || ["STARTING","RUNNING","STOPPING"].includes(state)} placeholder="C:\\Games\\Call of Duty 4" />
        {preflight?.baseGame && <div style={{fontSize:10,color:baseGameOk?C.success:C.danger,marginTop:5}}>{baseGameOk ? (de?"BaseGame geprüft.":"BaseGame checked.") : (preflight.baseGame.reasons||[]).map(item=>item.message).join(" · ")}</div>}
      </Field>

      <Field
        label={de ? "CoD4X Dedicated Server Core" : "CoD4X dedicated server core"}
        help={de ? "Der erkannte oder ausgewählte Dedicated-Server-Core. Client-EXEs wie iw3mp.exe werden hier nicht akzeptiert." : "The discovered or selected dedicated server core. Client executables such as iw3mp.exe are not accepted here."}
      >
        <div style={{display:"flex",gap:7}}>
          <input
            style={{...inputStyle,flex:1}}
            value={executablePath}
            onChange={e=>setExecutablePath(e.target.value)}
            disabled={state==="RUNNING"}
            placeholder={platform==="windows"?"C:\\CoD4X\\cod4x18_dedrun.exe":"/opt/cod4x/cod4x18_dedrun"}
          />
          <button onClick={chooseExecutable} disabled={busy || state==="RUNNING"} style={buttonStyle}>
            {de ? "Core auswählen" : "Select core"}
          </button>
          <button
            onClick={()=>saveConfig()}
            disabled={busy || state==="RUNNING" || !executablePath}
            style={{...buttonStyle,color:C.accent,border:`1px solid ${C.accent}55`}}
          >
            {de ? "Speichern" : "Save"}
          </button>
        </div>
      </Field>

      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
        <button
          onClick={searchCores}
          disabled={busy || searching || state==="RUNNING"}
          style={{...buttonStyle,color:C.accent,border:`1px solid ${C.accent}55`}}
        >
          {searching ? (de ? "Suche läuft…" : "Searching…") : (de ? "Dedicated Server Cores suchen" : "Search for dedicated server cores")}
        </button>
      </div>

      {candidates.length > 0 && (
        <div style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:6,padding:10,marginBottom:12}}>
          <div style={{fontSize:11,color:C.text,fontWeight:700,marginBottom:7}}>
            {de ? "Gefundene Dedicated Server Cores" : "Found dedicated server cores"}
          </div>
          <div style={{display:"grid",gap:6}}>
            {candidates.map(c=>(
              <div key={c.executable} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,background:C.surface,border:`1px solid ${C.border}`,borderRadius:5,padding:"7px 9px"}}>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:10,color:C.text,wordBreak:"break-all"}}>{c.executable}</div>
                  <div style={{fontSize:9,color:C.muted}}>
                    {c.platform ? `${c.platform === "windows" ? "Windows" : "Linux"} · ` : ""}
                    {c.source ? `${c.source} · ` : ""}
                    {c.size != null ? `${c.size.toLocaleString(de ? "de-DE" : "en-US")} Bytes` : ""}
                  </div>
                </div>
                <button onClick={()=>useCandidate(c)} disabled={busy || state==="RUNNING"} style={buttonStyle}>
                  {de ? "Übernehmen" : "Use"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {preflight && (
        <div style={{background:C.code,border:`1px solid ${coreOk ? C.success : C.border}`,borderRadius:6,padding:10,marginBottom:12,fontSize:10}}>
          <div style={{display:"grid",gap:6}}>
            <span style={{color:C.muted}}>
              {de ? "Server-Daten (fs_homepath)" : "Server data (fs_homepath)"}: <code style={{color:C.text}}>{preflight.resolvedTarget || "—"}</code>
            </span>
            <span style={{color:C.muted}}>
              {de ? "Dedicated Core" : "Dedicated core"}: <code style={{color:C.text,wordBreak:"break-all"}}>{preflight.executablePath || executablePath || "—"}</code>
            </span>
          </div>
          <div style={{display:"flex",justifyContent:"flex-end",marginTop:-18}}>
            <span style={{color:coreOk ? C.success : C.danger,fontWeight:700}}>
              {coreOk ? "VERIFIED" : "NOT VERIFIED"}
            </span>
          </div>
          {!coreOk && (
            <div style={{color:C.muted,marginTop:6}}>
              {(preflight.core?.reasons || []).join(" · ") || "Verified-Core-Prüfung fehlgeschlagen."}
            </div>
          )}
          {coreOk && preflight?.core?.manifestSource && (
            <div style={{color:C.muted,marginTop:6}}>
              {de ? "Integritätsnachweis" : "Integrity proof"}: {preflight.core.manifestSource}
              {preflight.core.verificationMode ? ` · ${preflight.core.verificationMode}` : ""}
            </div>
          )}
          {!coreOk && preflight?.core?.corePresent && (
            <button
              onClick={adopt}
              disabled={busy}
              style={{...buttonStyle,marginTop:8,color:C.accent,border:`1px solid ${C.accent}55`}}
            >
              {de ? "Dedicated-Core übernehmen & verifizieren" : "Adopt & verify dedicated server core"}
            </button>
          )}
        </div>
      )}

      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:12}}>
        <button onClick={()=>action("start")} disabled={busy || ["STARTING","RUNNING","STOPPING"].includes(state) || !coreOk || !baseGameOk} style={{...buttonStyle,color:C.success,border:`1px solid ${C.success}55`}}>Start</button>
        <button onClick={()=>action("restart")} disabled={busy || state!=="RUNNING"} style={buttonStyle}>Restart</button>
        <button onClick={()=>action("stop")} disabled={busy || state!=="RUNNING"} style={{...buttonStyle,color:C.danger,border:`1px solid ${C.danger}55`}}>Stop</button>
        <button onClick={load} disabled={busy} style={buttonStyle}>{de ? "Aktualisieren" : "Refresh"}</button>
        <Tag color={stateColor}>{state}</Tag>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:7,fontSize:10,color:C.muted}}>
        <div>PID: <span style={{color:C.text,fontFamily:"monospace"}}>{runtime?.pid || "—"}</span></div>
        <div>{de ? "Dedicated Core" : "Executable"}: <span style={{color:C.text,fontFamily:"monospace",wordBreak:"break-all"}}>{runtime?.executablePath || executablePath || "—"}</span></div>
        <div>{de ? "Server-Daten (fs_homepath)" : "Server data (fs_homepath)"}: <span style={{color:C.text,fontFamily:"monospace"}}>{runtime?.filesystemHomePath || runtime?.resolvedTarget || runtime?.target || "—"}</span></div>
        <div>{de ? "OS-Arbeitsverzeichnis" : "OS working directory"}: <span style={{color:C.text,fontFamily:"monospace"}}>{runtime?.workingDirectory || "—"}</span></div>
        <div>{de ? "CoD4X fs_basepath" : "CoD4X fs_basepath"}: <span style={{color:C.text,fontFamily:"monospace"}}>{runtime?.filesystemBasePath || "—"}</span></div>
        <div>Start: <span style={{color:C.text}}>{runtime?.startedAt ? new Date(runtime.startedAt).toLocaleString(de ? "de-DE" : "en-US") : "—"}</span></div>
      </div>
      {runtime?.lastError && (
        <div style={{marginTop:10,background:C.code,border:`1px solid ${C.danger}66`,borderRadius:5,padding:"9px 10px",fontSize:10,color:C.danger,wordBreak:"break-word"}}>
          <strong>{de ? "Letzter Runtime-Fehler:" : "Last runtime error:"}</strong> {runtime.lastError}
        </div>
      )}
      <RuntimePersistenceWarning runtime={runtime} de={de} style={{color:C.danger,fontSize:11,marginTop:10,wordBreak:"break-word"}} />
    </Section>

    <Section title={de ? "Runtime-Historie" : "Runtime history"}>
      {!runtime?.history?.length ? (
        <div style={{fontSize:11,color:C.muted}}>{de ? "Noch keine Runtime-Ereignisse." : "No runtime events yet."}</div>
      ) : (
        <div style={{display:"grid",gap:5}}>
          {runtime.history.slice(0,20).map((e,i)=>(
            <div key={i} style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"7px 9px",fontSize:10}}>
              <span style={{color:C.muted}}>{new Date(e.timestamp).toLocaleString(de ? "de-DE" : "en-US")}</span>
              <span style={{color:C.accent,fontFamily:"monospace",marginLeft:8}}>{e.event}</span>
              {e.pid && <span style={{color:C.muted,marginLeft:8}}>PID {e.pid}</span>}
              {e.executablePath && <span style={{color:C.muted,marginLeft:8,wordBreak:"break-all"}}>{e.executablePath}</span>}
            </div>
          ))}
        </div>
      )}
    </Section>

    <Section title={de ? "Sicherheitsgrenzen 4.18.12" : "4.18.12 security boundaries"}>
      <div style={{fontSize:10,color:C.muted,lineHeight:1.7}}>
        Windows Runtime startet ausschließlich <code style={{color:C.text}}>cod4x18_dedrun.exe</code> · Linux-Core <code style={{color:C.text}}>cod4x18_dedrun</code> ist für Discovery/Verifikation vorbereitet · Client-EXE <code style={{color:C.text}}>iw3mp.exe</code> wird nicht als Server-Core akzeptiert · getrenntes Server-Arbeitsverzeichnis je Instanz (<code style={{color:C.text}}>fs_homepath</code>) · Verified-Core Gate · <code style={{color:C.text}}>shell:false</code> · PID-/Pfad-Verifikation nach Spawn · begrenztes stdout/stderr · kontrollierter Stop mit Prozessende-Prüfung · persistenter Runtime-State · SHA-256-Fingerprint · Core-Nachweis im Runtime-Core-Registry-Verzeichnis möglich · schema-basierte Instanzkonfiguration mit Vorprüfung, Backup, Apply, Verify, Restore und Aktivierungsnachweis · RCON nur über 127.0.0.1 mit Befehls-Allowlist, Passwort nur kurzlebig aus dem Tresor und redigiert in Runtime-History/-Output · optionaler Master-Token (<code style={{color:C.text}}>sv_authtoken</code>) aus dem Tresor, Serverstart nie davon abhängig · Netzwerkbindung standardmäßig Loopback, öffentlich nur ausdrücklich pro Instanz bestätigt · Master-List-Prüfung gegen die offizielle Liste · Plugins nur mit freigegebenem SHA-256, Abweichung blockiert den Start · B3-Abhängigkeiten nur per fester Interpreter-Probe und statischer Quellprüfung, B3 wird nicht gestartet · B3 als eigener Prozess je Instanz, unabhängig vom Server-Lebenszyklus, nur mit geprüftem eBc-B3 · B3-Health-Dashboard mit getrennter Fehlerdiagnose, B3-publist dauerhaft unterdrückt · Audit + Correlation-ID.
      </div>
    </Section>
  </>;

}

const TABS=[["overview","⌂"],["config","⚙"],["mods","▣"],["security","✓"],["diagnostics","◉"],["runtime","▶"],["audit","≡"],["rcon","⌘"],["versions","⇩"],["tools","•"]];


function RBACPanel({lang}){
  const [data,setData]=useState(null);
  const [me,setMe]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [check,setCheck]=useState(null);
  const [authorization,setAuthorization]=useState(null);
  const [authorizationBusy,setAuthorizationBusy]=useState(false);

  async function load(){
    setBusy(true); setError("");
    try{
      const headers=authHeaders();
      const [rolesRes,meRes]=await Promise.all([
        apiFetch(apiUrl("/api/rbac/roles"),{headers}),
        apiFetch(apiUrl("/api/rbac/me"),{headers}),
      ]);
      const rolesBody=await rolesRes.json().catch(()=>({}));
      const meBody=await meRes.json().catch(()=>({}));
      if(!rolesRes.ok) throw new Error(rolesBody?.error||`HTTP ${rolesRes.status}`);
      if(!meRes.ok) throw new Error(meBody?.error||`HTTP ${meRes.status}`);
      setData(rolesBody); setMe(meBody);
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }

  async function checkPermission(permission){
    setCheck({permission,busy:true});
    try{
      const r=await apiFetch(apiUrl("/api/rbac/check"),{method:"POST",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify({permission})});
      const d=await r.json().catch(()=>({}));
      setCheck({permission,allowed:Boolean(d.allowed),error:r.ok?"":(d.error||`HTTP ${r.status}`)});
    }catch(e){setCheck({permission,error:e.message});}
  }

  async function checkAuthorizationBindings(){
    setAuthorizationBusy(true);
    try{
      const r=await apiFetch(apiUrl("/api/rbac/authorization"),{headers:authHeaders()});
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setAuthorization(d);
    }catch(e){setAuthorization({ok:false,error:e.message,checks:[]});}
    finally{setAuthorizationBusy(false);}
  }

  useEffect(()=>{load();},[]);

  return <div>
    <SectionHeader sub={lang==="de"?"Rollen, Permissions und Session-Bindung":"Roles, permissions and session binding"}>Fine-Grained RBAC</SectionHeader>
    {error&&<div style={{background:"rgba(239,68,68,.1)",border:`1px solid ${C.danger}55`,color:C.danger,borderRadius:6,padding:"9px 11px",fontSize:11,marginBottom:12}}>{error}</div>}
    <Section title={lang==="de"?"Aktive Session":"Active session"}>
      <div style={{display:"flex",gap:18,alignItems:"center",flexWrap:"wrap"}}>
        <Tag color={C.accent}>{me?.user?.role||"—"}</Tag>
        <span style={{fontSize:12,color:C.text}}>{me?.user?.username||"—"}</span>
        <span style={{fontSize:11,color:C.muted}}>{me?.permissions?.length||0} Permissions</span>
        <button onClick={load} disabled={busy} style={{...buttonStyle,marginLeft:"auto"}}>{busy?(lang==="de"?"Lade…":"Loading…"):(lang==="de"?"Aktualisieren":"Refresh")}</button>
      </div>
    </Section>
    <Section title={lang==="de"?"Endpoint Authorization Binding":"Endpoint Authorization Binding"}>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <button onClick={checkAuthorizationBindings} disabled={authorizationBusy} style={{...buttonStyle,background:authorization?.ok?"rgba(34,197,94,.10)":C.accentDim,border:`1px solid ${authorization?.ok?C.success:C.accent}55`,color:authorization?.ok?C.success:C.accent}}>
          {authorizationBusy?(lang==="de"?"Prüfe…":"Checking…"):(lang==="de"?"Authorization Binding prüfen":"Check authorization binding")}
        </button>
        {authorization&&<Tag color={authorization.ok?C.success:C.danger}>{authorization.ok?(lang==="de"?"BINDINGS OK":"BINDINGS OK"):(lang==="de"?"FEHLER":"FAILED")}</Tag>}
        {authorization?.checks?.length>0&&<span style={{fontSize:11,color:C.muted}}>{authorization.checks.filter(c=>c.pass).length}/{authorization.checks.length} Checks PASS</span>}
      </div>
      {authorization?.error&&<div style={{marginTop:10,padding:"8px 10px",background:"rgba(239,68,68,.08)",border:`1px solid ${C.danger}55`,color:C.danger,fontSize:11,borderRadius:5}}>{authorization.error}</div>}
      {authorization?.checks?.length>0&&<div style={{display:"grid",gap:6,marginTop:12}}>
        {authorization.checks.map(c=><div key={c.id} style={{display:"grid",gridTemplateColumns:"22px minmax(190px,1fr) auto",gap:8,alignItems:"center",background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"7px 9px"}}>
          <span style={{color:c.pass?C.success:C.danger,fontWeight:800,textAlign:"center"}}>{c.pass?"✓":"✕"}</span>
          <span style={{fontSize:11,color:C.text}}>{c.label}</span>
          <span style={{fontSize:10,color:c.pass?C.success:C.danger,fontFamily:"monospace"}}>{c.pass?"PASS":"FAIL"}</span>
        </div>)}
      </div>}
    </Section>
    <Section title={lang==="de"?"Permission-Katalog":"Permission catalog"}>
      {!data?<div style={{fontSize:11,color:C.muted}}>{lang==="de"?"Keine RBAC-Daten geladen.":"No RBAC data loaded."}</div>:
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
          <thead><tr>
            <th style={{textAlign:"left",padding:"7px 8px",color:C.muted,borderBottom:`1px solid ${C.border}`}}>Permission</th>
            {data.roles.map(role=><th key={role.id} style={{padding:"7px 8px",color:C.muted,borderBottom:`1px solid ${C.border}`}}>{role.id}</th>)}
            <th style={{padding:"7px 8px",color:C.muted,borderBottom:`1px solid ${C.border}`}}>Check</th>
          </tr></thead>
          <tbody>{data.permissions.map(permission=><tr key={permission.id}>
            <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`}}>
              <div style={{fontFamily:"monospace",color:C.accent}}>{permission.id}</div>
              <div style={{fontSize:10,color:C.muted,marginTop:2}}>{permission.description}</div>
            </td>
            {data.roles.map(role=>{
              const allowed=role.permissions.includes(permission.id);
              return <td key={role.id} style={{textAlign:"center",padding:"8px",borderBottom:`1px solid ${C.border}`,color:allowed?C.success:C.muted}}>{allowed?"✓":"—"}</td>;
            })}
            <td style={{textAlign:"center",padding:"8px",borderBottom:`1px solid ${C.border}`}}><button onClick={()=>checkPermission(permission.id)} style={{...buttonStyle,padding:"4px 8px",fontSize:10}}>check</button></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {check&&<div style={{marginTop:12,padding:"8px 10px",background:check.error?"rgba(239,68,68,.08)":"rgba(34,197,94,.08)",border:`1px solid ${check.error?C.danger:C.success}55`,color:check.error?C.danger:C.success,fontSize:11,borderRadius:5}}>
        {check.busy?"…":check.error?`${check.permission}: ${check.error}`:`${check.permission}: ${check.allowed?"ERLAUBT":"VERWEIGERT"}`}
      </div>}
    </Section>
  </div>;
}


function UserAdministrationPanel({lang, user}){
  const [users,setUsers]=useState([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [form,setForm]=useState({username:"",password:"",role:"viewer"});

  async function load(){
    setBusy(true); setError("");
    try{
      const r=await apiFetch(apiUrl("/api/users")); const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setUsers(d.users||[]);
    }catch(e){setError(e.message);} finally{setBusy(false);}
  }
  useEffect(()=>{ if(user?.role==="admin") load(); },[user?.role]);
  async function checkLifecycle(){
    setError("");setMessage("");setBusy(true);
    try{
      const r=await apiFetch(apiUrl("/api/backups/lifecycle"));
      const d=await r.json().catch(()=>({})); setLifecycle(d);
      if(!r.ok && !d?.maxTotal) throw new Error(d?.error||`HTTP ${r.status}`);
      setMessage(d.ok?`Lifecycle PASS · ${d.total} Backups · ${d.regular} normal · ${d.safety} Safety`:`Lifecycle Prüfung: Bereinigung erforderlich · ${d.deletable?.length||0} Backups betroffen · ${d.orphanFiles?.length||0} verwaiste Dateien`);
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function cleanupLifecycle(){
    if(!window.confirm("Backup-Lifecycle bereinigen? Dabei werden nur überzählige Backups und verwaiste Backup-Dateien innerhalb des sicheren Backup-Verzeichnisses entfernt."))return;
    setError("");setMessage("");setBusy(true);
    try{
      const r=await apiFetch(apiUrl("/api/backups/lifecycle/cleanup"),{method:"POST"});
      const d=await r.json().catch(()=>({})); setLifecycle(d.after||d);
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setMessage(`Lifecycle bereinigt · ${d.removedBackups||0} Backups · ${d.removedOrphans||0} verwaiste Dateien entfernt`); await load();
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function create(){
    setBusy(true); setError(""); setMessage("");
    try{ const r=await apiFetch(apiUrl("/api/users"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(form)}); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setForm({username:"",password:"",role:"viewer"}); setMessage("Benutzer angelegt."); await load(); }catch(e){setError(e.message);} finally{setBusy(false);}
  }
  async function update(username,patch){
    setError(""); setMessage("");
    try{ const r=await apiFetch(apiUrl(`/api/users/${encodeURIComponent(username)}`),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)}); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setMessage("Benutzer aktualisiert."); await load(); }catch(e){setError(e.message);}
  }
  async function revoke(username){
    if(!window.confirm(`Alle Sessions von ${username} widerrufen?`)) return;
    try{ const r=await apiFetch(apiUrl(`/api/users/${encodeURIComponent(username)}/revoke`),{method:"POST"}); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setMessage(`${d.revoked||0} Session(s) widerrufen.`); await load(); }catch(e){setError(e.message);}
  }
  if(user?.role!=="admin") return null;
  return <Section title={lang==="de"?"Benutzer & Rollen":"Users & roles"}>
    {error&&<div style={{background:"rgba(239,68,68,.1)",border:`1px solid ${C.danger}55`,color:C.danger,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:10}}>{error}</div>}
    {message&&<div style={{background:"rgba(34,197,94,.08)",border:`1px solid ${C.success}55`,color:C.success,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:10}}>{message}</div>}
    <div style={{display:"grid",gridTemplateColumns:"1.2fr 1.2fr .8fr auto",gap:8,marginBottom:14}}>
      <input style={inputStyle} placeholder="Benutzername" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/><input style={inputStyle} type="password" placeholder="Passwort (≥12)" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/><select style={selectStyle} value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>{["admin","operator","auditor","viewer"].map(r=><option key={r}>{r}</option>)}</select><button onClick={create} disabled={busy} style={buttonStyle}>Anlegen</button>
    </div>
    <div style={{display:"grid",gap:6}}>
      {users.map(u=><div key={u.username} style={{display:"grid",gridTemplateColumns:"1.3fr .8fr .8fr auto auto",gap:8,alignItems:"center",background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"8px 10px"}}>
        <span style={{fontSize:11,color:C.text,fontFamily:"monospace"}}>{u.username}</span><select style={{...selectStyle,padding:"5px 7px"}} value={u.role} onChange={e=>update(u.username,{role:e.target.value})}>{["admin","operator","auditor","viewer"].map(r=><option key={r}>{r}</option>)}</select><span style={{fontSize:10,color:u.disabled?C.danger:C.success}}>{u.disabled?"DEAKTIVIERT":"AKTIV"}</span><button onClick={()=>update(u.username,{disabled:!u.disabled})} style={{...buttonStyle,padding:"5px 8px",fontSize:10}}>{u.disabled?"Aktivieren":"Deaktivieren"}</button><button onClick={()=>revoke(u.username)} style={{...buttonStyle,padding:"5px 8px",fontSize:10}}>Sessions widerrufen</button>
      </div>)}
    </div>
  </Section>;
}

function SessionManagementPanel({lang, user}){
  const [sessions,setSessions]=useState([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");

  async function load(){
    setBusy(true); setError("");
    try{ const r=await apiFetch(apiUrl("/api/sessions")); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setSessions(d.sessions||[]); }
    catch(e){setError(e.message);} finally{setBusy(false);}
  }
  useEffect(()=>{ if(user?.role==="admin") load(); },[user?.role]);

  async function revoke(sessionId){
    if(!window.confirm("Diese Session wirklich widerrufen?")) return;
    try{ const r=await apiFetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/revoke`),{method:"POST"}); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setMessage(d.revoked?"Session widerrufen.":"Session war nicht mehr aktiv."); await load(); }
    catch(e){setError(e.message);}
  }
  async function logoutOthers(){
    if(!window.confirm("Alle anderen aktiven Sessions abmelden?")) return;
    try{ const r=await apiFetch(apiUrl("/api/sessions/logout-all"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({includeCurrent:false})}); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setMessage(`${d.revoked||0} andere Session(s) abgemeldet.`); await load(); }
    catch(e){setError(e.message);}
  }
  async function logoutAll(){
    if(!window.confirm("ALLE Sessions einschließlich deiner aktuellen Session abmelden? Du musst dich danach erneut anmelden.")) return;
    try{ const r=await apiFetch(apiUrl("/api/sessions/logout-all"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({includeCurrent:true})}); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); localStorage.removeItem("cod4x.auth.token"); localStorage.removeItem("cod4x.auth.expiresAt"); localStorage.removeItem("cod4x.auth.sessionId"); window.location.reload(); }
    catch(e){setError(e.message);}
  }
  if(user?.role!=="admin") return null;
  const fmt=ts=>ts?new Date(ts).toLocaleString(lang==="de"?"de-DE":"en-US"):"—";
  return <Section title={lang==="de"?"Session Management & Security Controls":"Session Management & Security Controls"}>
    {error&&<div style={{background:"rgba(239,68,68,.1)",border:`1px solid ${C.danger}55`,color:C.danger,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:10}}>{error}</div>}
    {message&&<div style={{background:"rgba(34,197,94,.08)",border:`1px solid ${C.success}55`,color:C.success,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:10}}>{message}</div>}
    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
      <button onClick={load} disabled={busy} style={buttonStyle}>{busy?(lang==="de"?"Lade…":"Loading…"):(lang==="de"?"Sessions aktualisieren":"Refresh sessions")}</button>
      <button onClick={logoutOthers} style={{...buttonStyle,border:`1px solid ${C.accent}55`,color:C.accent}}>{lang==="de"?"Andere Sessions abmelden":"Logout other sessions"}</button>
      <button onClick={logoutAll} style={{...buttonStyle,border:`1px solid ${C.danger}55`,color:C.danger}}>{lang==="de"?"Alle Sessions abmelden":"Logout all sessions"}</button>
      <Tag color={C.muted}>{sessions.length} {lang==="de"?"aktiv":"active"}</Tag>
    </div>
    <div style={{fontSize:10,color:C.muted,marginBottom:10}}>Idle-Timeout: 30 Minuten · maximale Session-Laufzeit: 12 Stunden. Jede authentifizierte Anfrage verlängert die Idle-Frist innerhalb dieser Maximaldauer.</div>
    <div style={{display:"grid",gap:6}}>
      {sessions.map(s=><div key={s.sessionId} style={{display:"grid",gridTemplateColumns:"1.1fr .7fr .9fr 1.2fr 1.2fr auto",gap:8,alignItems:"center",background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"8px 10px"}}>
        <div><div style={{fontSize:11,color:C.text,fontFamily:"monospace"}}>{s.username}</div><div style={{fontSize:9,color:C.muted}}>{s.sessionId}</div></div>
        <span style={{fontSize:10,color:C.accent}}>{s.role}</span>
        <span style={{fontSize:10,color:s.current?C.success:C.muted}}>{s.current?(lang==="de"?"AKTUELL":"CURRENT"):""}</span>
        <span style={{fontSize:9,color:C.muted}}>Last: {fmt(s.lastSeenAt)}</span>
        <span style={{fontSize:9,color:C.muted}}>Expires: {fmt(s.expiresAt)}</span>
        <button onClick={()=>revoke(s.sessionId)} disabled={s.current} style={{...buttonStyle,padding:"5px 8px",fontSize:10,opacity:s.current?.5:1}}>{lang==="de"?"Widerrufen":"Revoke"}</button>
      </div>)}
      {!sessions.length&&<div style={{fontSize:11,color:C.muted}}>Keine aktiven Sessions.</div>}
    </div>
  </Section>;
}


function BackupRecoveryPanel({lang}){
  const [backups,setBackups]=useState([]),[status,setStatus]=useState(null),[consistency,setConsistency]=useState(null),[lifecycle,setLifecycle]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
  async function load(){
    setBusy(true);setError("");
    try{
      const [a,b]=await Promise.all([apiFetch(apiUrl("/api/backups")),apiFetch(apiUrl("/api/backups/status"))]);
      const ad=await a.json().catch(()=>({})),bd=await b.json().catch(()=>({}));
      if(!a.ok) throw new Error(ad?.error||`HTTP ${a.status}`); if(!b.ok) throw new Error(bd?.error||`HTTP ${b.status}`);
      setBackups(ad.backups||[]);setStatus(bd);
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  useEffect(()=>{load()},[]);
  async function checkConsistency(){
    setError("");setMessage("");setBusy(true);
    try{
      const r=await apiFetch(apiUrl("/api/backups/consistency"));
      const d=await r.json().catch(()=>({}));
      setConsistency(d);
      if(!r.ok && !d?.checks) throw new Error(d?.error||`HTTP ${r.status}`);
      setMessage(d.ok?`Konsistenz PASS · ${d.count||0} Backups geprüft`:`Konsistenz FEHLER · ${d.invalid?.length||0} ungültige Einträge · ${d.orphanFiles?.length||0} verwaiste Dateien`);
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function checkLifecycle(){
    setError("");setMessage("");setBusy(true);
    try{
      const r=await apiFetch(apiUrl("/api/backups/lifecycle"));
      const d=await r.json().catch(()=>({})); setLifecycle(d);
      if(!r.ok && !d?.maxTotal) throw new Error(d?.error||`HTTP ${r.status}`);
      setMessage(d.ok?`Lifecycle PASS · ${d.total} Backups · ${d.regular} normal · ${d.safety} Safety`:`Lifecycle Prüfung: Bereinigung erforderlich · ${d.deletable?.length||0} Backups betroffen · ${d.orphanFiles?.length||0} verwaiste Dateien`);
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function cleanupLifecycle(){
    if(!window.confirm("Backup-Lifecycle bereinigen? Dabei werden nur überzählige Backups und verwaiste Backup-Dateien innerhalb des sicheren Backup-Verzeichnisses entfernt."))return;
    setError("");setMessage("");setBusy(true);
    try{
      const r=await apiFetch(apiUrl("/api/backups/lifecycle/cleanup"),{method:"POST"});
      const d=await r.json().catch(()=>({})); setLifecycle(d.after||d);
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setMessage(`Lifecycle bereinigt · ${d.removedBackups||0} Backups · ${d.removedOrphans||0} verwaiste Dateien entfernt`); await load();
    }catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function create(){
    setBusy(true);setError("");setMessage("");
    try{const r=await apiFetch(apiUrl("/api/backups/create"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:"Production backup"})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||`HTTP ${r.status}`);setMessage(`Backup erstellt · SHA-256 ${d.backup.sha256}`);await load()}catch(e){setError(e.message)}finally{setBusy(false)}
  }
  async function verify(id){
    setError("");setMessage("");
    try{const r=await apiFetch(apiUrl(`/api/backups/${encodeURIComponent(id)}/integrity`));const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||`HTTP ${r.status}`);setMessage(d.valid?`Integrität PASS · ${d.actual}`:`Integrität FEHLER · Restore blockiert`);await load()}catch(e){setError(e.message)}
  }
  async function restore(id){
    if(!window.confirm("Dieses Backup wiederherstellen? Vor dem Restore wird automatisch ein Safety Snapshot erstellt."))return;
    setError("");setMessage("");
    try{const r=await apiFetch(apiUrl(`/api/backups/${encodeURIComponent(id)}/restore`),{method:"POST"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||`HTTP ${r.status}`);setMessage(`Restore PASS · Safety Snapshot: ${d.safetySnapshotId}`);await load()}catch(e){setError(e.message)}
  }
  return <Section title={lang==="de"?"Production Backup & Integrity-Gated Restore":"Production Backup & Integrity-Gated Restore"}>
    {error&&<div style={{background:"rgba(239,68,68,.1)",border:`1px solid ${C.danger}55`,color:C.danger,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:10}}>{error}</div>}
    {message&&<div style={{background:"rgba(34,197,94,.08)",border:`1px solid ${C.success}55`,color:C.success,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:10,wordBreak:"break-word"}}>{message}</div>}
    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
      <button onClick={load} disabled={busy} style={buttonStyle}>{busy?"Lade…":"Aktualisieren"}</button>
      <button onClick={create} disabled={busy} style={{...buttonStyle,border:`1px solid ${C.accent}55`,color:C.accent}}>Backup erstellen</button>
      <button onClick={checkConsistency} disabled={busy} style={buttonStyle}>Konsistenz prüfen</button>
      <button onClick={checkLifecycle} disabled={busy} style={buttonStyle}>Lifecycle prüfen</button>
      <button onClick={cleanupLifecycle} disabled={busy} style={{...buttonStyle,border:`1px solid ${C.accent}55`,color:C.accent}}>Lifecycle bereinigen</button>
      <Tag color={C.muted}>{backups.length}/50 Backups</Tag>
      {status&&<Tag color={C.accent}>SHA-256 · Integrity Gate aktiv</Tag>}
    </div>
    <div style={{fontSize:10,color:C.muted,marginBottom:10}}>4.16.5 Registry · 4.16.6 SHA-256 · 4.16.7 Restore-Gate · 4.16.8 Registry-Konsistenz · 4.16.9 Lifecycle/Retention. Restore erzeugt vorher automatisch einen Safety Snapshot.</div>
    {lifecycle&&<div style={{background:lifecycle.ok?"rgba(34,197,94,.06)":"rgba(245,158,11,.06)",border:`1px solid ${lifecycle.ok?C.success:C.accent}55`,borderRadius:6,padding:"8px 10px",fontSize:10,marginBottom:10}}><div style={{color:lifecycle.ok?C.success:C.accent,fontWeight:600,marginBottom:5}}>Backup-Lifecycle: {lifecycle.ok?"PASS":"BEREINIGUNG ERFORDERLICH"}</div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:4,color:C.muted}}><span>Gesamt: {lifecycle.total||0}/{lifecycle.maxTotal||50}</span><span>Normal: {lifecycle.regular||0}/{lifecycle.maxRegular||40}</span><span>Safety: {lifecycle.safety||0}/{lifecycle.maxSafety||10}</span><span>Überzählig: {lifecycle.deletable?.length||0}</span><span>Verwaist: {lifecycle.orphanFiles?.length||0}</span></div></div>}
    {consistency&&<div style={{background:consistency.ok?"rgba(34,197,94,.06)":"rgba(239,68,68,.08)",border:`1px solid ${consistency.ok?C.success:C.danger}55`,borderRadius:6,padding:"8px 10px",fontSize:10,marginBottom:10}}>
      <div style={{color:consistency.ok?C.success:C.danger,fontWeight:600,marginBottom:5}}>Backup-Konsistenz: {consistency.ok?"PASS":"FEHLER"}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:4,color:C.muted}}>
        {Object.entries(consistency.checks||{}).map(([k,v])=><span key={k} style={{color:v?C.success:C.danger}}>{v?"✓":"✕"} {k}</span>)}
      </div>
    </div>}
    <div style={{display:"grid",gap:6}}>
      {backups.map(b=><div key={b.id} style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"9px 10px",display:"grid",gap:6}}>
        <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"center"}}><div><div style={{fontSize:11,color:C.text}}>{b.label}</div><div style={{fontSize:9,color:C.muted}}>{new Date(b.createdAt).toLocaleString(lang==="de"?"de-DE":"en-US")} · {b.id}</div></div><span style={{fontSize:9,color:C.accent}}>SHA-256</span></div>
        <div style={{fontSize:9,color:C.muted,fontFamily:"monospace",wordBreak:"break-all"}}>{b.sha256}</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}><button onClick={()=>verify(b.id)} style={{...buttonStyle,padding:"5px 8px",fontSize:10}}>Integrität prüfen</button><button onClick={()=>restore(b.id)} style={{...buttonStyle,padding:"5px 8px",fontSize:10,border:`1px solid ${C.accent}55`,color:C.accent}}>Restore</button></div>
      </div>)}
      {!backups.length&&<div style={{fontSize:11,color:C.muted}}>Noch keine Production Backups vorhanden.</div>}
    </div>
  </Section>;
}

function AuditTrailPanel({lang}){
  const [events,setEvents]=useState([]);
  const [level,setLevel]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [bounded,setBounded]=useState(true);
  const [maxEvents,setMaxEvents]=useState(500);

  async function loadAudit(){
    setBusy(true); setError("");
    try{
      const qs=new URLSearchParams({limit:"100"}); if(level) qs.set("level",level);
      const r=await apiFetch(apiUrl(`/api/audit?${qs.toString()}`)); const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setEvents(Array.isArray(d.events)?d.events:[]); setBounded(Boolean(d.bounded)); setMaxEvents(Number(d.maxEvents)||500);
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  async function testEvent(){
    try{ const r=await apiFetch(apiUrl("/api/audit/test"),{method:"POST"}); if(!r.ok) throw new Error(`HTTP ${r.status}`); await loadAudit(); }
    catch(e){setError(e.message);}
  }
  useEffect(()=>{loadAudit();},[level]);
  const color=l=>l==="error"?C.danger:l==="warn"?C.accent:C.success;
  return <div>
    <SectionHeader sub={lang==="de"?"Nachvollziehbare Ereignisse für Installationen, Updates, Fehler und Diagnosen":"Traceable events for installs, updates, errors and diagnostics"}>
      {lang==="de"?"Logging & Audit Trail":"Logging & Audit Trail"}
    </SectionHeader>
    <Section title={lang==="de"?"Audit-Übersicht":"Audit overview"}>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <select style={{...selectStyle,width:150}} value={level} onChange={e=>setLevel(e.target.value)}>
          <option value="">{lang==="de"?"Alle Level":"All levels"}</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option>
        </select>
        <button onClick={loadAudit} disabled={busy} style={{...buttonStyle,opacity:busy?.65:1}}>{busy?(lang==="de"?"Lade…":"Loading…"):(lang==="de"?"Aktualisieren":"Refresh")}</button>
        <button onClick={testEvent} style={buttonStyle}>{lang==="de"?"Test-Event":"Test event"}</button>
        <span style={{fontSize:10,color:C.muted,marginLeft:"auto"}}>{bounded?`bounded / ${maxEvents}`:"unbounded"} · {events.length} {lang==="de"?"Ereignisse":"events"}</span>
      </div>
      {error&&<div style={{marginTop:10,color:C.danger,fontSize:11}}>{error}</div>}
    </Section>
    <Section title={lang==="de"?"Ereignisse":"Events"}>
      {events.length===0?<div style={{fontSize:11,color:C.muted}}>{lang==="de"?"Noch keine Audit-Ereignisse vorhanden.":"No audit events yet."}</div>:
      <div style={{display:"grid",gap:7}}>{events.map(e=><div key={e.id} style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"9px 10px",display:"grid",gridTemplateColumns:"145px 58px minmax(180px,260px) 1fr",gap:10,alignItems:"start"}}>
        <span style={{fontFamily:"monospace",fontSize:9,color:C.muted}}>{new Date(e.timestamp).toLocaleString(lang==="de"?"de-DE":"en-US")}</span>
        <span style={{fontFamily:"monospace",fontSize:10,color:color(e.level),fontWeight:700}}>{e.level}</span>
        <span style={{fontSize:11,color:C.text}}>{e.event}</span>
        <pre style={{margin:0,fontSize:9,color:C.muted,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{JSON.stringify(e.details||{},null,0)}</pre>
      </div>)}</div>}
    </Section>
  </div>;
}


function PersistentAuditPanel({lang}){
  const [events,setEvents]=useState([]);
  const [status,setStatus]=useState(null);
  const [checkpoint,setCheckpoint]=useState(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");

  async function loadPersistent(){
    setBusy(true); setMessage("");
    try{
      const r=await apiFetch(apiUrl("/api/audit/persistent?limit=100")); const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setEvents(Array.isArray(d.events)?d.events:[]);
      setStatus(d);
    }catch(e){setMessage(e.message);}
    finally{setBusy(false);}
  }
  async function persist(){
    try{ const r=await apiFetch(apiUrl("/api/audit/persist"),{method:"POST"}); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setMessage(lang==="de"?"Audit-Log synchronisiert.":"Audit log synchronized."); await loadPersistent(); }catch(e){setMessage(e.message);}
  }
  async function rotate(){
    try{ const r=await apiFetch(apiUrl("/api/audit/rotate"),{method:"POST"}); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setMessage(d.rotated?(lang==="de"?"Log rotiert.":"Log rotated."):(lang==="de"?"Kein Log zur Rotation vorhanden.":"No log available for rotation.")); await loadPersistent(); }catch(e){setMessage(e.message);}
  }
  async function getCheckpoint(){
    try{ const r=await apiFetch(apiUrl("/api/audit/checkpoint")); const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`); setCheckpoint(d.checkpoint||null); }catch(e){setMessage(e.message);}
  }
  useEffect(()=>{loadPersistent();},[]);
  return <div>
    <Section title={lang==="de"?"Persistenter Audit-Log":"Persistent audit log"}>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <button onClick={loadPersistent} disabled={busy} style={{...buttonStyle,opacity:busy?.65:1}}>{busy?(lang==="de"?"Lade…":"Loading…"):(lang==="de"?"Lesen":"Read")}</button>
        <button onClick={persist} style={buttonStyle}>{lang==="de"?"Synchronisieren":"Persist"}</button>
        <button onClick={rotate} style={buttonStyle}>{lang==="de"?"Log rotieren":"Rotate log"}</button>
        <button onClick={getCheckpoint} style={buttonStyle}>SHA-256</button>
        {status&&<span style={{fontSize:10,color:C.muted}}>{status.exists?`${status.bytes} bytes`:(lang==="de"?"Datei noch nicht vorhanden":"File not created yet")} · NDJSON</span>}
      </div>
      {message&&<div style={{marginTop:9,fontSize:10,color:message.includes("HTTP")?C.danger:C.muted}}>{message}</div>}
      {checkpoint&&<div style={{marginTop:9,padding:8,background:C.code,border:`1px solid ${C.border}`,borderRadius:5,fontFamily:"monospace",fontSize:9,color:C.muted,wordBreak:"break-all"}}>SHA-256: {checkpoint.hash} · {checkpoint.bytes} bytes</div>}
    </Section>
    <Section title={lang==="de"?"Persistierte Ereignisse":"Persisted events"}>
      {events.length===0 ? (
        <div style={{fontSize:11,color:C.muted}}>{lang==="de"?"Keine persistierten Audit-Ereignisse vorhanden.":"No persisted audit events."}</div>
      ) : (
        <div style={{display:"grid",gap:7}}>{events.map(e=>(
          <div key={e.id} style={{background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"9px 10px",display:"grid",gridTemplateColumns:"145px 58px minmax(180px,260px) 1fr",gap:10,alignItems:"start"}}>
            <span style={{fontFamily:"monospace",fontSize:9,color:C.muted}}>{new Date(e.timestamp).toLocaleString(lang==="de"?"de-DE":"en-US")}</span>
            <span style={{fontFamily:"monospace",fontSize:10,color:e.level==="error"?C.danger:e.level==="warn"?C.accent:C.success,fontWeight:700}}>{e.level}</span>
            <span style={{fontSize:11,color:C.text}}>{e.event}</span>
            <pre style={{margin:0,fontSize:9,color:C.muted,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{JSON.stringify(e.details||{},null,0)}</pre>
          </div>
        ))}</div>
      )}
    </Section>
  </div>;
}

function PersistentLogHardeningPanel({lang}){
  const [result,setResult]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  async function loadHardening(){
    setBusy(true); setError("");
    try{
      const r=await apiFetch(apiUrl("/api/audit/hardening"));
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setResult(d);
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }

  useEffect(()=>{loadHardening();},[]);

  return <Section title={lang==="de"?"Persistent-Log-Hardening":"Persistent log hardening"}>
    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
      <button onClick={loadHardening} disabled={busy} style={{...buttonStyle,opacity:busy?.65:1}}>
        {busy?(lang==="de"?"Prüfe…":"Checking…"):(lang==="de"?"Hardening prüfen":"Check hardening")}
      </button>
      {result&&<span style={{fontSize:10,color:result.ok?C.success:C.danger,fontFamily:"monospace",fontWeight:700}}>
        {result.ok?(lang==="de"?"HARDENING: PASS":"HARDENING: PASS"):(lang==="de"?"HARDENING: BLOCKIERT":"HARDENING: BLOCKED")}
      </span>}
      {result&&<span style={{fontSize:10,color:C.muted,marginLeft:"auto"}}>
        {result.bytes} / {result.maxBytes} bytes · {result.rotatedCount}/{result.maxRotated} rotated
      </span>}
    </div>
    {error&&<div style={{marginTop:9,color:C.danger,fontSize:11}}>{error}</div>}
    {result&&<div style={{display:"grid",gap:6,marginTop:12}}>
      {(result.checks||[]).map(c=><div key={c.id} style={{display:"grid",gridTemplateColumns:"24px minmax(180px,250px) 1fr",gap:8,alignItems:"center",background:C.code,border:`1px solid ${C.border}`,borderRadius:5,padding:"7px 9px"}}>
        <span style={{color:c.pass?C.success:C.danger,fontWeight:800,textAlign:"center"}}>{c.pass?"✓":"×"}</span>
        <span style={{fontSize:10,color:C.text}}>{c.label}</span>
        <span style={{fontSize:9,color:C.muted,wordBreak:"break-word"}}>{c.detail}</span>
      </div>)}
    </div>}
    {result&&<div style={{marginTop:10,fontSize:9,color:C.muted}}>
      {lang==="de"?"Aktives Log: max. 10 MiB · Rotation: vor Überschreitung · Aufbewahrung: 7 Dateien · Schreibmodus: append · Rechte: 0600":"Active log: max 10 MiB · rotation before limit · retention: 7 files · write mode: append · permissions: 0600"}
    </div>}
  </Section>;
}



function ConfigurationProfilesPanel({lang}){
  const [profiles,setProfiles]=useState([]);
  const [active,setActive]=useState(null);
  const [name,setName]=useState("");
  const [json,setJson]=useState(`{
  "sv_hostname": "^1My ^7CoD4x Server",
  "sv_maxclients": 18,
  "net_port": 28960,
  "g_gametype": "war"
}`);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");

  async function loadProfiles(){
    setBusy(true); setError("");
    try{
      const r=await apiFetch(apiUrl("/api/config/profiles")); const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setProfiles(Array.isArray(d.profiles)?d.profiles:[]); setActive(d.active||null);
    }catch(e){setError(e.message);} finally{setBusy(false);}
  }
  function selectProfile(p){setName(p.name); setJson(JSON.stringify(p.config,null,2));}
  async function saveProfile(){
    setBusy(true); setMessage(""); setError("");
    try{
      if(!name.trim()) throw new Error(lang==="de"?"Profilname fehlt.":"Profile name is required.");
      let config; try{config=JSON.parse(json);}catch(e){throw new Error(lang==="de"?"Konfiguration ist kein gültiges JSON.":"Configuration is not valid JSON.");}
      const r=await apiFetch(apiUrl("/api/config/profiles/save"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,config})});
      const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setProfiles(d.profiles||[]); setActive(d.active||null); setMessage(lang==="de"?"Profil gespeichert und Policy-validiert.":"Profile saved and policy-validated.");
    }catch(e){setError(e.message);} finally{setBusy(false);}
  }
  async function activateProfile(){
    setBusy(true); setMessage(""); setError("");
    try{
      const target=name.trim(); if(!target) throw new Error(lang==="de"?"Profil auswählen.":"Select a profile.");
      const r=await apiFetch(apiUrl("/api/config/profiles/activate"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:target})});
      const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setActive(d.active||target); setMessage(lang==="de"?`Profil „${target}“ aktiviert.`:`Profile “${target}” activated.`);
    }catch(e){setError(e.message);} finally{setBusy(false);}
  }
  async function deleteProfile(){
    setBusy(true); setMessage(""); setError("");
    try{
      const target=name.trim(); if(!target) throw new Error(lang==="de"?"Profil auswählen.":"Select a profile.");
      const r=await apiFetch(apiUrl("/api/config/profiles/delete"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:target})});
      const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setProfiles(d.profiles||[]); setActive(d.active||null); setMessage(lang==="de"?"Profil gelöscht.":"Profile deleted.");
    }catch(e){setError(e.message);} finally{setBusy(false);}
  }
  useEffect(()=>{loadProfiles();},[]);
  return <Section title={lang==="de"?"Configuration Profiles":"Configuration Profiles"}>
    <div style={{fontSize:10,color:C.muted,marginBottom:12}}>
      {lang==="de"?"Persistente Server-Konfigurationsprofile. Speichern wird vorab gegen die aktive Policy validiert; maximal 20 Profile.":"Persistent server configuration profiles. Saves are validated against the active policy; maximum 20 profiles."}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"minmax(220px,1fr) 2fr",gap:12}}>
      <div>
        <Field label={lang==="de"?"Profilname":"Profile name"}>
          <input style={inputStyle} value={name} onChange={e=>setName(e.target.value)} placeholder="promod-war" />
        </Field>
        <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:10}}>
          <button onClick={loadProfiles} disabled={busy} style={buttonStyle}>{lang==="de"?"Neu laden":"Reload"}</button>
          <button onClick={saveProfile} disabled={busy} style={buttonStyle}>{lang==="de"?"Speichern":"Save"}</button>
          <button onClick={activateProfile} disabled={busy} style={buttonStyle}>{lang==="de"?"Aktivieren":"Activate"}</button>
          <button onClick={deleteProfile} disabled={busy} style={{...buttonStyle,color:C.danger,borderColor:C.danger+"55"}}>{lang==="de"?"Löschen":"Delete"}</button>
        </div>
        <div style={{fontSize:9,color:C.muted,marginBottom:6}}>{profiles.length}/20 {lang==="de"?"Profile · aktiv":"profiles · active"}: {active||"—"}</div>
        <div style={{display:"grid",gap:5,maxHeight:220,overflow:"auto"}}>
          {profiles.map(p=><button key={p.name} onClick={()=>selectProfile(p)} style={{textAlign:"left",background:p.name===active?C.accentDim:C.code,border:`1px solid ${p.name===active?C.accent:C.border}`,borderRadius:5,padding:"7px 9px",color:p.name===active?C.accent:C.text,cursor:"pointer",fontSize:11}}>{p.name}{p.name===active?" · ACTIVE":""}</button>)}
          {!profiles.length&&<div style={{fontSize:10,color:C.muted}}>{lang==="de"?"Noch keine Profile gespeichert.":"No profiles saved yet."}</div>}
        </div>
      </div>
      <div>
        <Field label={lang==="de"?"Konfiguration (JSON)":"Configuration (JSON)"}>
          <textarea value={json} onChange={e=>setJson(e.target.value)} spellCheck={false} style={{...inputStyle,minHeight:250,resize:"vertical",fontFamily:"monospace",fontSize:11,lineHeight:1.5}} />
        </Field>
      </div>
    </div>
    {message&&<div style={{marginTop:9,fontSize:10,color:C.success}}>{message}</div>}
    {error&&<div style={{marginTop:9,fontSize:10,color:C.danger}}>{error}</div>}
  </Section>;
}

function ConfigurationPolicyPanel({lang}){
  const [policy,setPolicy]=useState(null);
  const [draft,setDraft]=useState(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");

  async function loadPolicy(){
    setBusy(true); setError("");
    try{
      const r=await apiFetch(apiUrl("/api/policy")); const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setPolicy(d.policy); setDraft(d.policy);
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  function setAudit(key,value){setDraft(p=>({...p,audit:{...p.audit,[key]:value}}));}
  async function validate(){
    setBusy(true); setMessage(""); setError("");
    try{
      const r=await apiFetch(apiUrl("/api/policy/validate"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({policy:draft})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error((d.errors||[]).join("; ")||d?.error||`HTTP ${r.status}`);
      setMessage(lang==="de"?"Policy ist gültig.":"Policy is valid.");
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  async function save(){
    setBusy(true); setMessage(""); setError("");
    try{
      const r=await apiFetch(apiUrl("/api/policy/save"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({policy:draft})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setPolicy(d.policy); setDraft(d.policy); setMessage(lang==="de"?"Policy gespeichert und aktiv.":"Policy saved and active.");
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  useEffect(()=>{loadPolicy();},[]);
  const mib=draft?Math.round(draft.audit.maxBytes/1024/1024):10;
  return <Section title={lang==="de"?"Configuration & Policy Engine":"Configuration & Policy Engine"}>
    <div style={{fontSize:10,color:C.muted,marginBottom:12}}>
      {lang==="de"?"Zentrale, validierte Policy für Audit-Retention, Größenlimits und Sicherheitsgrenzen.":"Central validated policy for audit retention, size limits and security boundaries."}
    </div>
    {draft&&<div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(160px,1fr))",gap:12}}>
      <Field label={lang==="de"?"Aktives Audit-Log (MiB)":"Active audit log (MiB)"}>
        <input style={inputStyle} type="number" min="1" max="100" value={mib} onChange={e=>setAudit("maxBytes",Math.round(Number(e.target.value)*1024*1024))}/>
      </Field>
      <Field label={lang==="de"?"Rotierte Logs behalten":"Retained rotated logs"}>
        <input style={inputStyle} type="number" min="1" max="30" value={draft.audit.maxRotated} onChange={e=>setAudit("maxRotated",Number(e.target.value))}/>
      </Field>
      <Field label={lang==="de"?"Max. persistierte Reads":"Max persisted reads"}>
        <input style={inputStyle} type="number" min="50" max="5000" value={draft.audit.persistReadLimit} onChange={e=>setAudit("persistReadLimit",Number(e.target.value))}/>
      </Field>
    </div>}
    {draft&&<div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginTop:4}}>
      <button onClick={loadPolicy} disabled={busy} style={buttonStyle}>{lang==="de"?"Neu laden":"Reload"}</button>
      <button onClick={validate} disabled={busy} style={buttonStyle}>{lang==="de"?"Policy prüfen":"Validate policy"}</button>
      <button onClick={save} disabled={busy} style={buttonStyle}>{lang==="de"?"Policy speichern":"Save policy"}</button>
      {policy&&<span style={{fontSize:9,color:C.muted}}>v{policy.version} · {policy.security.allowedCod4xVersions.join(" / ")} · {policy.security.targets.join(" / ")}</span>}
    </div>}
    {message&&<div style={{marginTop:9,fontSize:10,color:C.success}}>{message}</div>}
    {error&&<div style={{marginTop:9,fontSize:10,color:C.danger}}>{error}</div>}
  </Section>;
}

function SecurityPanel({t,lang}){
  const [fpsAcCatalog,setFpsAcCatalog]=useState([]);
  const [securityCod4x,setSecurityCod4x]=useState("21.5");
  const [securityTarget,setSecurityTarget]=useState("server");
  const [securityPath,setSecurityPath]=useState("./server");
  const [securityCheck,setSecurityCheck]=useState(null);
  const [securityBusy,setSecurityBusy]=useState(false);
  const [fpsAcVersion,setFpsAcVersion]=useState("9.2.0");
  const [loading,setLoading]=useState(false);
  const [status,setStatus]=useState("");
  const [anticheat,setAnticheat]=useState("fpschallenge");
  const [enforce,setEnforce]=useState(true);
  const [screenshots,setScreenshots]=useState(true);
  const [rconHost,setRconHost]=useState("127.0.0.1");
  const [rconPort,setRconPort]=useState("28960");
  const [rconPassword,setRconPassword]=useState("");

  async function runSecurityCheck(){
    setSecurityBusy(true); setSecurityCheck(null);
    try{
      const qs=new URLSearchParams({cod4x:securityCod4x,target:securityTarget,path:securityPath});
      const r=await apiFetch(apiUrl(`/api/security/status?${qs.toString()}`));
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
      setSecurityCheck(d);
    }catch(e){setSecurityCheck({ok:false,error:e.message});}
    finally{setSecurityBusy(false);}
  }

  async function loadCatalog(){
    setLoading(true); setStatus("");
    try{
      const r=await apiFetch(apiUrl("/api/fpschallenge/anticheat/catalog"));
      const d=await r.json();
      setFpsAcCatalog(d.versions||[]);
      if(d.latest) setFpsAcVersion(d.latest);
    }catch(e){setStatus("Download catalog unavailable");}
    finally{setLoading(false);}
  }

  return <div>
    <Header title={lang==="de"?"Sicherheit":"Security"} sub={lang==="de"?"Security Hardening, Anti-Cheat und Serverzugriff":"Security hardening, anti-cheat and server access"}/>
    <Section title={lang==="de"?"Security Hardening":"Security Hardening"}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 2fr",gap:10}}>
        <Field label="CoD4x"><select style={selectStyle} value={securityCod4x} onChange={e=>setSecurityCod4x(e.target.value)}><option value="21.2">21.2</option><option value="21.3">21.3</option><option value="21.4">21.4</option><option value="21.5">21.5</option></select></Field>
        <Field label={lang==="de"?"Ziel":"Target"}><select style={selectStyle} value={securityTarget} onChange={e=>setSecurityTarget(e.target.value)}><option value="server">Server</option><option value="client">Client</option></select></Field>
        <Field label={lang==="de"?"Installationspfad":"Installation path"}><input style={inputStyle} value={securityPath} onChange={e=>setSecurityPath(e.target.value)} placeholder="./server"/></Field>
      </div>
      <button style={buttonStyle} disabled={securityBusy} onClick={runSecurityCheck}>{securityBusy?(lang==="de"?"Prüfe…":"Checking…"):(lang==="de"?"Security-Prüfung starten":"Run security check")}</button>
      {securityCheck&&<div style={{marginTop:12,padding:10,background:C.code,border:`1px solid ${securityCheck.ok?C.success:C.danger}55`,borderRadius:6}}>
        {securityCheck.error ? <div style={{color:C.danger,fontSize:11}}>{securityCheck.error}</div> : <>
          <div style={{fontSize:11,color:securityCheck.ok?C.success:C.accent,fontWeight:700}}>{securityCheck.ok?(lang==="de"?"Security-Gate: PASS":"Security gate: PASS"):(lang==="de"?"Security-Gate: BLOCKIERT":"Security gate: BLOCKED")}</div>
          <div style={{display:"grid",gap:5,marginTop:8}}>{(securityCheck.checks||[]).map(c=><div key={c.id} style={{fontSize:10,color:c.pass?C.success:C.danger,fontFamily:"monospace"}}>{c.pass?"PASS":"FAIL"} · {c.label}</div>)}</div>
          <div style={{fontSize:10,color:securityCheck.verifiedCore?.verified?C.success:C.muted,marginTop:8}}>Verified-Core: {securityCheck.verifiedCore?.verified?"verified":"not verified"}</div>
        </>}
      </div>}
    </Section>
    <Section title={lang==="de"?"Anti-Cheat":"Anti-Cheat"}>
      <Field label={lang==="de"?"Anbieter":"Provider"}>
        <select style={selectStyle} value={anticheat} onChange={e=>setAnticheat(e.target.value)}>
          <option value="fpschallenge">FPSChallenge Anti-Cheat / FPSAC</option>
          <option value="cod4x">CoD4x Anti-Cheat Settings</option>
          <option value="ruscod">RUSCOD Anti-Cheat</option>
          <option value="none">Disabled</option>
        </select>
      </Field>
      {anticheat==="fpschallenge" && <>
        <Field label="FPSAC Version">
          <select style={selectStyle} value={fpsAcVersion} onChange={e=>setFpsAcVersion(e.target.value)}>
            <option value="9.2.0">9.2.0</option>
            {fpsAcCatalog.filter(v=>v.id!=="9.2.0").map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
          <button style={buttonStyle} disabled={loading} onClick={loadCatalog}>{loading?"Laden…":"FPSAC-Versionen laden"}</button>
          <a href={apiUrl("/api/fpschallenge/anticheat/download/9.2.0")} style={{...buttonStyle,textDecoration:"none"}}>FPSAC 9.2.0 herunterladen</a>
        </div>
        <div style={{display:"flex",gap:18,fontSize:11,color:C.muted}}>
          <label><input type="checkbox" checked={enforce} onChange={e=>setEnforce(e.target.checked)}/> Enforce</label>
          <label><input type="checkbox" checked={screenshots} onChange={e=>setScreenshots(e.target.checked)}/> Screenshots</label>
        </div>
        {status&&<div style={{fontSize:11,color:C.danger,marginTop:8}}>{status}</div>}
      </>}
    </Section>
    <Section title="RCON">
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10}}>
        <Field label="Host"><input style={inputStyle} value={rconHost} onChange={e=>setRconHost(e.target.value)} /></Field>
        <Field label="Port"><input style={inputStyle} value={rconPort} onChange={e=>setRconPort(e.target.value)} /></Field>
      </div>
      <Field label="RCON Password"><input style={inputStyle} type="password" value={rconPassword} onChange={e=>setRconPassword(e.target.value)} /></Field>
      <div style={{fontSize:10,color:C.muted}}>RCON is sent server-side; the password is never written to the application log.</div>
    </Section>
  </div>;
}

function Header({title,sub}){return <div style={{marginBottom:22}}><h1 style={{fontSize:22,fontWeight:650,margin:0,color:C.text}}>{title}</h1><div style={{fontSize:11,color:C.muted,marginTop:5}}>{sub}</div></div>;}
function Section({title,children}){return <section style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:18,marginBottom:14}}><div style={{fontSize:11,fontWeight:700,color:C.text,marginBottom:14}}>{title}</div>{children}</section>;}

function AuthGate(){
  const [mode,setMode]=useState("loading");
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [rememberPassword,setRememberPassword]=useState(false);
  const [rememberAvailable,setRememberAvailable]=useState(false);
  const [rememberError,setRememberError]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [user,setUser]=useState(null);
  const [expiresAt,setExpiresAt]=useState(0);

  async function request(path, body){
    const r=await apiFetch(apiUrl(path),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d?.error||`HTTP ${r.status}`);
    return d;
  }

  async function completeLogin(d, credentials, shouldRemember){
    localStorage.setItem("cod4x.auth.token",d.token);
    localStorage.setItem("cod4x.auth.expiresAt",String(d.expiresAt));
    if(d.sessionId) localStorage.setItem("cod4x.auth.sessionId",String(d.sessionId));
    if(shouldRemember && window.cod4xControl?.saveRememberedLogin){
      try{ await window.cod4xControl.saveRememberedLogin(credentials.username,credentials.password); }catch{}
    }else if(window.cod4xControl?.clearRememberedLogin){
      try{ await window.cod4xControl.clearRememberedLogin(); }catch{}
    }
    setUser(d.user);
    setExpiresAt(d.expiresAt);
    setPassword("");
    setMode("authenticated");
  }

  async function bootstrap(){
    try{
      const status=await apiFetch(apiUrl("/api/auth/status"));
      const d=await status.json();
      let remembered=null;
      if(window.cod4xControl?.getRememberedLogin){
        try{
          const stored=await window.cod4xControl.getRememberedLogin();
          const available=Boolean(stored?.available);
          setRememberAvailable(available);
          setRememberError(available?"":"Windows secure credential storage is currently unavailable.");
          remembered=stored?.credentials||null;
          if(remembered) setRememberPassword(true);
        }catch(e){
          setRememberAvailable(false);
          setRememberError(e?.message||"Die sichere Windows-Anmeldespeicherung konnte nicht initialisiert werden.");
        }
      }else{
        setRememberAvailable(false);
        setRememberError("Die sichere Windows-Anmeldespeicherung ist in dieser App-Instanz nicht verfügbar.");
      }

      const token=localStorage.getItem("cod4x.auth.token");
      if(token){
        const me=await apiFetch(apiUrl("/api/auth/me"),{headers:{Authorization:`Bearer ${token}`}});
        if(me.ok){
          const md=await me.json();
          setUser(md.user);
          setExpiresAt(Number(localStorage.getItem("cod4x.auth.expiresAt")||0));
          setMode("authenticated");
          return;
        }
        localStorage.removeItem("cod4x.auth.token");
        localStorage.removeItem("cod4x.auth.expiresAt");
        localStorage.removeItem("cod4x.auth.sessionId");
      }

      if(d.initialized && remembered){
        setUsername(remembered.username);
        try{
          const login=await request("/api/auth/login",remembered);
          await completeLogin(login,remembered,true);
          return;
        }catch{
          // A changed/revoked password must not cause an endless auto-login loop.
          try{ await window.cod4xControl?.clearRememberedLogin?.(); }catch{}
          setRememberPassword(false);
          setError("Die gespeicherte Anmeldung ist nicht mehr gültig. Bitte erneut anmelden.");
        }
      }

      setMode(d.initialized?"login":"init");
    }catch(e){ setError(e.message); setMode("error"); }
  }

  useEffect(()=>{bootstrap();},[]);

  async function submit(e){
    e.preventDefault(); if(busy) return;
    setBusy(true); setError("");
    try{
      const credentials={username:username.trim(),password};
      const d=await request(mode==="init"?"/api/auth/init":"/api/auth/login",credentials);
      await completeLogin(d,credentials,mode!=="init" && rememberPassword);
    }catch(e){setError(e.message);}
    finally{setBusy(false);}
  }

  async function logout(){
    const token=localStorage.getItem("cod4x.auth.token");
    try{if(token) await apiFetch(apiUrl("/api/auth/logout"),{method:"POST",headers:{Authorization:`Bearer ${token}`}});}catch{}
    localStorage.removeItem("cod4x.auth.token");
    localStorage.removeItem("cod4x.auth.expiresAt");
    localStorage.removeItem("cod4x.auth.sessionId");
    setUser(null);
    setMode("login");
    setPassword("");
  }

  if(mode==="loading") return <div style={{minHeight:"100vh",background:C.bg,color:C.muted,display:"grid",placeItems:"center",fontFamily:"Inter,Segoe UI,system-ui,sans-serif"}}>Authentifizierung wird geladen…</div>;
  if(mode==="error") return <div style={{minHeight:"100vh",background:C.bg,color:C.danger,display:"grid",placeItems:"center",fontFamily:"Inter,Segoe UI,system-ui,sans-serif"}}>{error}</div>;
  if(mode!=="authenticated") return <div style={{minHeight:"100vh",background:C.bg,color:C.text,display:"grid",placeItems:"center",fontFamily:"Inter,Segoe UI,system-ui,sans-serif",padding:24}}>
    <form onSubmit={submit} style={{width:"100%",maxWidth:420,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:24,boxSizing:"border-box"}}>
      <div style={{color:C.accent,fontFamily:"monospace",fontWeight:800,fontSize:13,letterSpacing:"0.12em",marginBottom:5}}>COD4X CONTROL</div>
      <div style={{color:C.muted,fontSize:10,letterSpacing:"0.08em",marginBottom:22}}>{mode==="init"?"FIRST-RUN ADMIN INITIALIZATION":"AUTHENTICATION"}</div>
      <h1 style={{fontSize:19,margin:"0 0 7px",fontWeight:650}}>{mode==="init"?"Administrator einrichten":"Anmelden"}</h1>
      <div style={{fontSize:11,color:C.muted,marginBottom:18}}>{mode==="init"?`Mindestens ${12} Zeichen für das Administrator-Passwort.`:"30 Minuten Session-Lifetime."}</div>
      <Field label="Benutzername"><input autoFocus style={inputStyle} value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" /></Field>
      <Field label="Passwort"><input style={inputStyle} type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==="init"?"new-password":"current-password"} /></Field>
      {mode==="login"&&<div style={{margin:"2px 0 14px"}}>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:rememberAvailable?C.text:C.muted,cursor:rememberAvailable?"pointer":"not-allowed"}}>
          <input type="checkbox" checked={rememberPassword} disabled={!rememberAvailable} onChange={e=>setRememberPassword(e.target.checked)} />
          <span>Passwort auf diesem Windows-Konto merken</span>
        </label>
        <div style={{fontSize:9,color:rememberAvailable?C.muted:C.danger,lineHeight:1.45,marginTop:5}}>
          {rememberAvailable?"Das Passwort wird verschlüsselt über den Windows-Anmeldekontext gespeichert und nicht als Klartext abgelegt.":`Nicht verfügbar: ${rememberError||"Windows Secure Storage konnte nicht aktiviert werden."}`}
        </div>
      </div>}
      {error&&<div style={{background:"rgba(239,68,68,.1)",border:`1px solid ${C.danger}55`,color:C.danger,borderRadius:6,padding:"8px 10px",fontSize:11,marginBottom:12}}>{error}</div>}
      <button type="submit" disabled={busy} style={{...buttonStyle,width:"100%",opacity:busy?.65:1}}>{busy?(mode==="init"?"Initialisiere…":"Anmeldung…"):(mode==="init"?"Administrator initialisieren":"Anmelden")}</button>
      {mode==="init"&&<div style={{fontSize:10,color:C.muted,marginTop:12,lineHeight:1.5}}>Das Passwort wird als scrypt-Hash gespeichert. Der Klartext wird nicht persistiert.</div>}
    </form>
  </div>;

  return <ControlApp user={user} expiresAt={expiresAt} onLogout={logout}/>;
}

function App(){ return <AuthGate/>; }

function ControlApp({user,onLogout}){
  const [tab,setTab]=useState("config"),[lang,setLang]=useState("de");
  const t=I18N[lang];
  const labels={
    overview:lang==="de"?"Übersicht":"Overview",
    config:t.config,rotation:t.rotation,mods:lang==="de"?"Mods":"Mods",
    security:lang==="de"?"Sicherheit":"Security",diagnostics:lang==="de"?"Diagnose":"Diagnostics",runtime:lang==="de"?"Runtime":"Runtime",audit:lang==="de"?"Audit":"Audit",rcon:t.rcon,
    versions:t.versionManager,tools:lang==="de"?"Werkzeuge":"Tools"
  };
  const currentLabel=labels[tab]||"COD4X CONTROL";
  return <div className="app-shell" style={{display:"flex",background:C.bg,minHeight:"100vh",fontFamily:"Inter,Segoe UI,system-ui,sans-serif",color:C.text}}>
    <aside className="app-sidebar" style={{width:228,minHeight:"100vh",background:C.surface,borderRight:`1px solid ${C.border}`,display:"flex",flexDirection:"column",flexShrink:0}}>
      <div className="brand-block">
        <div className="brand-row"><span className="brand-mark">C4X</span><div><div className="brand-title">COD4X CONTROL</div><div className="brand-sub">SERVER MANAGEMENT TOOL</div></div></div>
        <div className="brand-meta"><span>COD4X 21.5</span><span className="status-dot"></span><span>READY</span></div>
      </div>
      <div className="sidebar-caption">CONTROL PANEL</div>
      <nav style={{flex:1}}>{TABS.map(([id,icon])=>{const active=tab===id;return <button className={`nav-item ${active?"active":""}`} key={id} onClick={()=>setTab(id)} aria-current={active?"page":undefined} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"11px 16px",cursor:"pointer",background:active?C.accentDim:"transparent",border:0,borderLeft:`3px solid ${active?C.accent:"transparent"}`,color:active?C.accent:C.muted,fontSize:13,textAlign:"left"}}><span className="nav-icon" style={{fontFamily:"monospace",fontSize:15,minWidth:20}}>{icon}</span><span>{labels[id]}</span>{active&&<span className="nav-arrow">›</span>}</button>})}</nav>
      <div className="sidebar-footer" style={{padding:"12px 14px",borderTop:`1px solid ${C.border}`}}>
        <div style={{display:"flex",gap:5,marginBottom:9}}><button onClick={()=>setLang("de")} style={langBtn(lang==="de")}>DE</button><button onClick={()=>setLang("en")} style={langBtn(lang==="en")}>EN</button></div>
        <div className="sidebar-version">CoD4x 21.5 · iw3mp<br/>RCON: UDP / 28960</div>
      </div>
    </aside>
    <main className="app-main" style={{flex:1,padding:"0 30px 30px",overflow:"auto",maxWidth:"calc(100vw - 228px)"}}>
      <header className="topbar">
        <div><div className="topbar-kicker">COD4X CONTROL <span>/</span> {currentLabel.toUpperCase()}</div><div className="topbar-title">{tab==="overview"?"SERVER OVERVIEW":"SERVER ADMINISTRATION"}</div></div>
        <div className="topbar-right"><span className="topbar-version">4.18.12</span><span style={{color:C.muted,fontSize:10}}>{user?.username||""}</span><button onClick={onLogout} style={{...langBtn(false),padding:"4px 8px"}}>Logout</button><span className="live-status"><i></i> LOCAL CONTROL READY</span></div>
      </header>
      <div className="content-frame">
        {tab==="overview"&&<><Header title="COD4X CONTROL" sub={lang==="de"?"Serververwaltung":"Server administration"}/><Section title={lang==="de"?"Server":"Server"}><div style={{fontSize:12,color:C.muted}}>Bereit. Wähle links nur den Bereich, den du gerade benötigst.</div></Section></>}
        {tab==="config"&&<ConfigBuilder t={t} lang={lang}/>}
        {tab==="rotation"&&<MapRotationBuilder t={t}/>}
        {tab==="mods"&&<VersionManager t={t} lang={lang}/>}
        {tab==="security"&&<SecurityPanel t={t} lang={lang}/>}
        {tab==="diagnostics"&&<DiagnosticsPanel t={t} lang={lang}/>}
        {tab==="runtime"&&<ProductionRuntimePanel lang={lang}/>}
        {tab==="audit"&&<><RBACPanel lang={lang}/><UserAdministrationPanel lang={lang} user={user}/><SessionManagementPanel lang={lang} user={user}/><BackupRecoveryPanel lang={lang}/><AuditTrailPanel lang={lang}/><PersistentAuditPanel lang={lang}/><PersistentLogHardeningPanel lang={lang}/><ConfigurationPolicyPanel lang={lang}/><ConfigurationProfilesPanel lang={lang}/></>}
        {tab==="rcon"&&<RCONCommands t={t}/>}
        {tab==="versions"&&<VersionManager t={t} lang={lang}/>}
        {tab==="tools"&&<><DvarBrowser t={t}/><GSCAssistant t={t} lang={lang}/></>}
      </div>
      <footer className="app-footer"><span>COD4X CONTROL 4.18.12</span><span>DEDICATED SERVER MANAGEMENT</span><span>BUILD / CONFIG / CONTROL</span></footer>
    </main>
  </div>;
}

function langBtn(active){return {background:active?C.accentDim:C.surface,border:`1px solid ${active?C.accent:C.border}`,color:active?C.accent:C.muted,borderRadius:4,padding:"3px 7px",fontSize:10,cursor:"pointer"};}

export default App;
