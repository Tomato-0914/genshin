//开发维护&&反馈群190370034，作者devil
// 移植自 https://github.com/devil233-ui/HoyoMaterialPack
import plugin from "../../../lib/plugins/plugin.js";
import puppeteer from "../../../lib/puppeteer/puppeteer.js";
import fetch from "node-fetch";
import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";
import crypto from "node:crypto";
import MysInfo from "../model/mys/mysInfo.js";
import { Material } from "#miao.models";
import { Version } from "#miao";

// 是否在进行原神的全部查询时展示受计算器上限影响的不准确材料（武器突破、天赋与武器培养培养），后者即精英+普通敌人掉落
// true: 默认展示所有 | false: 在全量一图流中隐藏，单独查询不受影响
const SHOW_COMPUTE_IN_ALL = true;

//本插件根据游戏内进行的自定义分类（有别于喵喵）
const MANUAL_DICT = {
  other: [{ name: "摩拉" }],
  talent: [{ name: "智识之冕" }, { name: "命运的足迹" }],
};

const WEEKLY_LIST = [];

export class materialPack extends plugin {
  constructor() {
    super({
      name: "米游材料背包",
      dsc: "全局动态分类材料背包(原铁绝)",
      event: "message",
      priority: -114514,
      rule: [
        {
          reg: "^#?(原神)?周本(材料|素材)背包(升序|降序)?$",
          fnc: "materialsWeekly",
        },
        //崩铁和绝区零只支持全部查询（种类太少没必要）
        {
          reg: "^#?(原神)?(星铁|崩铁)?(绝区零)?(培养|矿物|木材|其他|道具|天赋|武器|特产|boss|角色突破|全部)?(材料|素材)背包$",
          fnc: "materials",
        },
      ],
    });
    this.mapDict = null;
    this._path = process.cwd().replace(/\\/g, "/");
  }

  //   async materials() {
  // let msg = this.e.msg.replace(/^#/, '')
  async materials() {
    let msg = this.e.msg
      .replace(/^#/, "")
      .replace(/(星铁|崩铁|绝区零|zzz)/gi, "");

    this.e.isZzz =
      this.e.msg.includes("绝区零") ||
      this.e.msg.toLowerCase().includes("zzz") ||
      this.e.isZzz;

    const cmdMap = {
      矿物: "ore",
      木材: "wood",
      其他: "other",
      道具: "adventureItem",
      天赋: "talent",
      武器: "weapon",
      特产: "specialty",
      boss: "boss",
      角色突破: "gem",
    };

    let target = null;
    let isDevelop = msg.includes("培养");

    for (let [k, v] of Object.entries(cmdMap)) {
      if (msg.includes(k)) {
        target = v;
        break;
      }
    }

    let isAll = msg.includes("全部") || (!target && !isDevelop);

    let data = await this.getMaterialsData(target, isAll, isDevelop);
    if (!data) return;

    let img = await puppeteer.screenshot("materialPack", {
      ...data,
      tplFile:
        "./plugins/genshin/resources/html/materialPack/materialPack.html",
      pluResPath: `${this._path}/plugins/genshin/resources/`,
      pageGotoParams: {
        timeout: 60000,
        waitUntil: "domcontentloaded",
      },
      waitForImages: isAll ? 15000 : 5000,
    });
    if (img) await this.reply(img);
  }

  async getMaterialsData(target, isAll, isDevelop) {
    let uid = await MysInfo.getUid(this.e);
    if (!uid) return false;

    let binding = (await MysInfo.checkUidBing(uid, this.e)) || {};
    if (!binding.ck) return (this.e.reply(MysInfo.tips), false);
    let ck = binding.ck;

    await this.e.reply(
      `正在获取UID：${uid} 背包数据，请稍等...`,
    );

    let raw;
    if (this.e.isZzz) {
      let region = "prod_gf_cn";
      raw = await this.fetchZzzRawMaterials(uid, ck, region);
    } else if (this.e.isSr) {
      let region = "prod_gf_cn";
      if (String(uid).startsWith("5")) region = "prod_qd_cn";
      else if (["6", "7", "8", "9"].includes(String(uid)[0])) {
        const map = {
          6: "prod_official_usa",
          7: "prod_official_euro",
          8: "prod_official_asia",
          9: "prod_official_cht",
        };
        region = map[String(uid)[0]];
      }
      raw = await this.fetchSrRawMaterials(uid, ck, region);
    } else {
      raw = await this.fetchRawMaterials(uid, ck);
    }

    let role;
    let silentE = { ...this.e, reply: () => {} };
    try {
      let apiName = this.e.isSr ? "srIndex" : "index";
      let res = await MysInfo.get(silentE, apiName);
      role = res?.data?.role;
    } catch (e) {}

    if (this.e.isSr && this.srRoleInfo) {
      role = {
        nickname: this.srRoleInfo.nickname || "开拓者",
        level: this.srRoleInfo.level || "??",
        AvatarUrl: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${this.e.user_id || this.e.sender?.user_id || "10000"}`,
      };
    }
    if (!role || !role.nickname) {
      role = {
        nickname: this.e.sender?.card || this.e.sender?.nickname || "开拓者",
        level: "??",
        AvatarUrl: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${this.e.user_id || this.e.sender?.user_id || "10000"}`,
      };
    }

    if (!raw || raw.length === 0)
      return (
        this.e.reply(
          "获取失败：米游社鉴权拦截或CK权限不足（请确保绑定的CK含有 stoken）。",
        ),
        false
      );

    let materials = {};
    if (isAll) {
      materials = raw;
      if (!SHOW_COMPUTE_IN_ALL) {
        delete materials["weapon"];
        // delete materials['boss'] //用户相关：你要是大世界boss都能爆那就把这行注释去掉
        delete materials["monster"];
        delete materials["normal"];
      }
    } else if (isDevelop) {
      materials["monster"] = raw["monster"] || [];
      materials["normal"] = raw["normal"] || [];
    } else if (target) {
      materials[target] = raw[target] || [];
    }

    if (target === "weekly" || !target) {
      materials["weekly"] = raw["weekly"] || [];
    }

    // 🚨 探针：查看万一被拦截时最终喂给 HTML 的大类有哪些
    console.log(`[米游背包] 探针：最终渲染大类包含 ->`, Object.keys(materials));

    return {
      _res_path: `${path.resolve("./plugins/genshin/resources")}/`,
      _miao_path: `${path.resolve("./plugins/miao-plugin/resources")}/`,
      defaultLayout: path.join(
        path.resolve("./plugins/miao-plugin/resources"),
        "common/layout/default.html",
      ),
      sys: {
        copyright: `Created By ${Version.name}<span class="version">${Version.yunzai}</span> & genshin · HoyoMaterialPack`,
      },
      uid,
      role,
      materials,
      isSr: this.e.isSr,
      isZzz: this.e.isZzz,
    };
  }

  // ==================== 原神专属核心逻辑 ====================
  async getDynamicComputePayload(ck) {
    let headers = {
      Cookie: ck,
      "Content-Type": "application/json",
      Referer: "https://webstatic.mihoyo.com",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    };
    let avatarItems = [];
    let weaponItems = [];

    try {
      let aUrl =
        "https://api-takumi.mihoyo.com/event/e20200928calculate/v1/avatar/list";
      let aRes = await fetch(aUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ page: 1, size: 1000, is_all: true }),
      }).then((r) => r.json());
      if (aRes?.retcode === 0 && aRes.data?.list) {
        aRes.data.list.forEach((a) => {
          if (a.id == 118 || a.id == 117) return;
          if (a.name === "旅行者" || !a.skill_list) return;
          let skill_list = a.skill_list
            .filter((s) => s.max_level > 1)
            .map((s) => ({
              id: s.group_id,
              level_current: 1,
              level_target: 10,
            }));
          if (skill_list.length === 0) return;
          avatarItems.push({
            avatar_id: a.id,
            avatar_level_current: 1,
            avatar_level_target: 90,
            skill_list: skill_list,
          });
        });
      }
    } catch (e) {
      console.error("获取全量角色图鉴失败", e);
    }

    try {
      let wUrl =
        "https://api-takumi.mihoyo.com/event/e20200928calculate/v1/weapon/list";
      let wRes = await fetch(wUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          page: 1,
          size: 1000,
          weapon_levels: [1, 2, 3, 4, 5],
        }),
      }).then((r) => r.json());
      if (wRes?.retcode === 0 && wRes.data?.list) {
        wRes.data.list.forEach((w) => {
          if (w.id == 118 || w.id == 117) return;
          weaponItems.push({
            weapon: {
              id: w.id,
              level_current: 1,
              level_target: w.weapon_level <= 2 ? 70 : w.max_level || 90,
            },
          });
        });
      }
    } catch (e) {
      console.error("获取全量武器图鉴失败", e);
    }

    return { avatarItems, weaponItems };
  }

  async fetchRawMaterials(uid, ck) {
    let mergedData = new Map();
    let manualDict = MANUAL_DICT;
    let weeklyList = WEEKLY_LIST;
    let dict = await this.getMapDict();

    const getDynamicType = (item) => {
      let name = item.name;
      if (Object.keys(manualDict).length > 0) {
        for (let cat in manualDict) {
          if (Object.values(manualDict[cat]).some((i) => i.name === name)) {
            const map = {
              weekly: "weekly",
              talent: "talent",
              weapon: "weapon",
              boss: "boss",
              gem: "gem",
              specialty: "specialty",
              monster: "monster",
              normal: "normal",
              ore: "ore",
              wood: "wood",
              adventureItem: "adventureItem",
            };
            return map[cat] || "other";
          }
        }
      }

      for (let [boss, items] of weeklyList) {
        if (items && items.includes(name)) return "weekly";
      }

      let meta = Material.get(name);
      if (
        meta?.type &&
        [
          "boss",
          "gem",
          "weapon",
          "monster",
          "normal",
          "talent",
          "specialty",
        ].includes(meta.type)
      ) {
        return meta.type;
      }

      if (/的(教导|指引|哲学)$/.test(name)) return "talent";

      let info =
        dict[item.id] || Object.values(dict).find((v) => v.name === name);
      if (info?.parent) {
        let p = info.parent;
        if (p.includes("特产")) return "specialty";
        if (p.includes("矿物")) return "ore";
        if (p.includes("武器突破")) return "weapon";
        if (p.includes("角色培养")) return "boss";
        if (p.includes("角色突破")) return "gem";
        if (p.includes("收集物") || p.includes("宝箱") || p.includes("道具"))
          return "adventureItem";
        if (p.includes("普通")) return "normal";
        if (p.includes("精英") || p.includes("首领")) return "monster";
        if (p.includes("角色与武器培养")) return "monster";
        if (p.includes("木材")) return "wood";
      }
      return "other";
    };

    try {
      let mapUrl =
        "https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/user/sync_game_material_info?map_id=2&app_sn=ys_obc&lang=zh-cn";
      let mapRes = await fetch(mapUrl, {
        headers: { Cookie: ck, Referer: "https://act.mihoyo.com" },
      }).then((res) => res.json());
      if (mapRes?.retcode === 0) {
        for (let [id, num] of Object.entries(mapRes.data.material_info)) {
          if (num <= 0) continue;
          let name = dict[id]?.name || Material.get(Number(id))?.name;
          if (!name) continue;

          let icon = dict[id]?.icon || "";
          let type = getDynamicType({ id: Number(id), name });
          let level = Number(Material.get(name)?.star || 1);
          mergedData.set(name, {
            id: Number(id),
            name,
            num,
            icon,
            type,
            level,
          });
        }
      }
    } catch (e) {
      console.error("大地图接口错误:", e);
    }

    let { avatarItems, weaponItems } = await this.getDynamicComputePayload(ck);

    let region =
      String(uid)[0] === "1" || String(uid)[0] === "2" ? "cn_gf01" : "cn_qd01";
    let fpRes = await MysInfo.get(this.e, "getFp");
    let fp = fpRes?.data?.device_fp || "";
    let silentE = { ...this.e, reply: () => {} };

    let computeBodies = [];
    if (avatarItems.length > 0)
      computeBodies.push({ items: avatarItems, uid: String(uid), region });
    if (weaponItems.length > 0)
      computeBodies.push({ items: weaponItems, uid: String(uid), region });

    for (let reqBody of computeBodies) {
      try {
        let res = await MysInfo.get(silentE, "compute", {
          body: reqBody,
          headers: { "x-rpc-device_fp": fp },
        });

        let dataObj = res?.data || res;

        this.weeklyBossMap = this.weeklyBossMap || new Map();
        this.weeklyBossIconMap = this.weeklyBossIconMap || new Map();
        if (dataObj?.overall_material_consume) {
          let ov = dataObj.overall_material_consume;
          ["avatar_consume", "avatar_skill_consume", "weapon_consume"].forEach(
            (key) => {
              (ov[key] || []).forEach((srcObj) => {
                if (
                  srcObj.material_source === "MT_WEEKLY_DUNGEON" &&
                  srcObj.monster?.monster_name
                ) {
                  let boss = srcObj.monster.monster_name;
                  this.weeklyBossIconMap = this.weeklyBossIconMap || new Map();

                  if (srcObj.monster.monster_icon) {
                    this.weeklyBossIconMap.set(
                      boss,
                      srcObj.monster.monster_icon,
                    );
                    // // 🚨 探针1：每抓到一个头像就打印一次
                    // if (global.logger) logger.mark(`[米游背包] 成功抓取头像 -> ${boss}: ${srcObj.monster.monster_icon}`);
                  }
                  (srcObj.consume || []).forEach((mat) => {
                    this.weeklyBossMap.set(String(mat.id), boss);
                  });
                }
              });
            },
          );
          if (global.logger)
            logger.mark(
              `[米游背包] 动态周本捕获数量: ${this.weeklyBossMap.size}`,
            );
        }

        if (Array.isArray(dataObj?.overall_consume)) {
          dataObj.overall_consume.forEach((val) => {
            let owned =
              val.lack_num < 0
                ? Math.abs(val.lack_num) + val.num
                : val.num - val.lack_num;
            if (owned >= 0) {
              if (mergedData.has(val.name)) {
                mergedData.get(val.name).num = Math.max(
                  mergedData.get(val.name).num,
                  owned,
                );
                mergedData.get(val.name).level = Number(
                  val.rarity || mergedData.get(val.name).level || 1,
                );
              } else {
                let type = getDynamicType(val);
                if (
                  this.weeklyBossMap &&
                  this.weeklyBossMap.has(String(val.id))
                )
                  type = "weekly";
                let level = Number(
                  val.rarity || Material.get(val.name)?.star || 1,
                );
                mergedData.set(val.name, {
                  id: val.id,
                  name: val.name,
                  num: owned,
                  icon: val.icon,
                  type,
                  level,
                });
              }
            }
          });
        }
      } catch (e) {
        console.error(`处理计算器数据时出错:`, e);
      }
    }

    let ret = { length: 0 };
    for (let item of mergedData.values()) {
      if (this.weeklyBossMap && this.weeklyBossMap.has(String(item.id))) {
        item.type = "weekly";
      }
      ret[item.type] ||= [];
      ret[item.type].push(item);
      ret.length++;
    }

    for (let i in ret) {
      if (Array.isArray(ret[i])) {
        ret[i].sort((a, b) => {
          // 摩拉置顶
          if (a.name === "摩拉") return -1;
          if (b.name === "摩拉") return 1;
          // 智识之冕置底
          if (a.name === "智识之冕") return 1;
          if (b.name === "智识之冕") return -1;
          // 其余按 id 降序
          return b.id - a.id;
        });
      }
    }
    return ret;
  }

  async getMapDict() {
    if (this.mapDict) return this.mapDict;
    try {
      let url =
        "https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/map/label/tree?map_id=2&app_sn=ys_obc&lang=zh-cn";
      let res = await fetch(url).then((res) => res.json());
      if (res?.retcode === 0) {
        let dict = {};
        const flatten = (nodes, parentPath) => {
          nodes.forEach((node) => {
            let currentPath = [...parentPath, node.name];
            if (node.children && node.children.length > 0) {
              flatten(node.children, currentPath);
            } else {
              dict[node.id] = {
                name: node.name,
                icon: node.icon,
                parent: currentPath.join("-"),
              };
            }
          });
        };
        flatten(res.data.tree, []);
        this.mapDict = dict;
        return dict;
      }
    } catch (e) {
      console.error("获取大地图字典报错:", e);
    }
    return {};
  }

  async materialsWeekly() {
    let data = await this.getMaterialsData("weekly", false, false);
    if (!data) return;

    let weeklyList = WEEKLY_LIST;

    if (!data?.materials?.weekly || data.materials.weekly.length === 0)
      return this.reply("周本材料查询为空");

    const {
      materials: { weekly },
    } = data;
    const dataMap = new Map();
    const countMap = new Map();

    for (const item of weekly) {
      let bossName = this.weeklyBossMap?.get(String(item.id)) || null;
      if (!bossName) {
        for (let [name, items] of weeklyList) {
          if (items && items.includes(item.name)) {
            bossName = name;
            break;
          }
        }
      }
      if (bossName) {
        if (!dataMap.has(bossName)) {
          dataMap.set(bossName, []);
          countMap.set(bossName, 0);
        }
        dataMap.get(bossName).push(item);
        countMap.set(bossName, countMap.get(bossName) + item.num);
      }
    }

    if (!dataMap.size) return this.reply("未找到匹配周本，请检查字典配置");
    data.weeklyList = [...dataMap.keys()].map((name) => {
      let iconUrl = this.weeklyBossIconMap?.get(name) || "";
      // // 🚨 探针2：看看最终传给 HTML 的是不是空字符串
      // if (global.logger) logger.mark(`[米游背包] 传给前端 -> Boss: ${name}, 携带头像链接: ${iconUrl ? "成功" : "为空!"}`);
      return [name, countMap.get(name), dataMap.get(name), iconUrl];
    });

    let img = await puppeteer.screenshot("materialWeeklyPack", {
      ...data,
      tplFile: `./plugins/genshin/resources/html/materialPack/materialWeeklyPack.html`,
      pluResPath: `${this._path}/plugins/genshin/resources/`,
      waitForImages: 5000,
    });
    if (img) await this.reply(img);
  }
  // ==================== 绝区零专属核心逻辑 ====================
  async fetchZzzRawMaterials(uid, ck, region) {
    let ckMap = {};
    ck.split(";").forEach((item) => {
      let i = item.indexOf("=");
      if (i > 0) {
        let k = item.substring(0, i).trim();
        let v = item.substring(i + 1).trim();
        if (k && v) ckMap[k] = v;
      }
    });

    try {
      let paths = [
        `${this._path}/plugins/xiaoyao-cvs-plugin/data/yaml/${this.e.user_id}.yaml`,
        `${this._path}/plugins/xhh/data/Stoken/${this.e.user_id}.yaml`,
      ];

      let foundStokenPath = null;

      for (let p of paths) {
        if (fs.existsSync(p)) {
          let data = YAML.parse(fs.readFileSync(p, "utf8"));
          let item =
            data[uid] ||
            Object.values(data).find((v) => String(v.uid) === String(uid));
          if (item) {
            let yamlStoken =
              item.stoken || item.ck_stoken?.match(/stoken=([^;]+)/)?.[1] || "";
            let yamlStuid = item.stuid || item.ltuid || uid;
            let yamlMid =
              item.mid || item.ck_stoken?.match(/mid=([^;]+)/)?.[1] || "";

            if (yamlStoken && yamlStuid) {
              ckMap["stoken"] = yamlStoken;
              ckMap["stuid"] = yamlStuid;
              ckMap["account_id"] = yamlStuid;
              ckMap["account_id_v2"] = yamlStuid;
              if (yamlMid) {
                ckMap["mid"] = yamlMid;
                ckMap["account_mid_v2"] = yamlMid;
              }
              foundStokenPath = p;
              break;
            }
          }
        }
      }

      if (foundStokenPath) {
        console.log(
          `[绝区零背包] 🎯 成功读取 stoken，来源文件: ${foundStokenPath}`,
        );
      } else {
        console.log(
          `[绝区零背包] ⚠️ 警告：遍历了所有路径，均未找到有效的 stoken！`,
        );
      }
    } catch (e) {
      console.error("[绝区零背包] 读取YAML失败", e);
    }

    let baseCk = Object.entries(ckMap)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    if (ckMap["stoken"] && ckMap["stuid"]) {
      try {
        let n = region.includes("official")
          ? "okr4obncj8bw5a65hbnn5oo6ixjc3l9w"
          : "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
        let t = Math.round(Date.now() / 1000);
        let r = Math.floor(Math.random() * 900000 + 100000);
        let b = JSON.stringify({
          uid: String(uid),
          region: region,
          game_biz: "nap_cn",
          lang: "zh-cn",
        });
        let DS = crypto
          .createHash("md5")
          .update(`salt=${n}&t=${t}&r=${r}&b=${b}&q=`)
          .digest("hex");

        let rawRes = await fetch(
          `https://api-takumi.mihoyo.com/common/badge/v1/login/account`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: baseCk,
              "x-rpc-client_type": "5",
              "x-rpc-app_version": "2.44.1",
              DS: `${t},${r},${DS}`,
            },
            body: b,
          },
        );

        let setCookiesStr = rawRes.headers.raw
          ? rawRes.headers.raw()["set-cookie"]?.join("; ") || ""
          : rawRes.headers.get("set-cookie") || "";
        let match = setCookiesStr.match(/e_nap_token=([^;, ]+)/);
        if (match) {
          ckMap["e_nap_token"] = match[1];
          console.log(`[绝区零背包] 🛀 拿到专属通行证 e_nap_token`);
        }
      } catch (e) {}
    }

    let finalCk = Object.entries(ckMap)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    let optimalAvatars = [
      1011, // 安比 (电-击破)
      1041, //「11号」 (火-强攻)
      1211, // 艾莲 (冰-强攻)
      1261, // 简 (物理-异常)
      1341, // 照（冰-防护）
      1371, // 仪玄 (以太-命破)
      1311, // 嘉音（以太-支援）
    ];

    let safeWeapons = [
      14125, //击破
      14105, //命破
      14129, //强攻
      14131, //支援
      14134, //防护
      14133, //异常
    ];

    let payloads = [];

    optimalAvatars.forEach((aId) => {
      payloads.push({
        _debug_name: `角色_${aId}`,
        avatar_id: aId,
        avatar_level: 60,
        avatar_current_level: 1,
        avatar_current_promotes: 0,
        skills: [
          { skill_type: 0, level: 12, init_level: 1 },
          { skill_type: 1, level: 11, init_level: 1 },
          { skill_type: 2, level: 7, init_level: 1 },
          { skill_type: 3, level: 11, init_level: 1 },
          { skill_type: 5, level: 7, init_level: 1 },
          { skill_type: 6, level: 7, init_level: 1 },
        ],
      });
    });

    safeWeapons.forEach((wId) => {
      payloads.push({
        _debug_name: `武器_${wId}`,
        avatar_id: 1011,
        avatar_level: 60,
        avatar_current_level: 60,
        avatar_current_promotes: 6,
        skills: [
          { skill_type: 0, level: 12, init_level: 12 },
          { skill_type: 1, level: 11, init_level: 11 },
          { skill_type: 2, level: 7, init_level: 7 },
          { skill_type: 3, level: 11, init_level: 11 },
          { skill_type: 5, level: 7, init_level: 7 },
          { skill_type: 6, level: 7, init_level: 7 },
        ],
        weapon_info: {
          weapon_id: wId,
          weapon_level: 60,
          weapon_promotes: 5,
          weapon_init_level: 1,
        },
      });
    });

    let url = `https://act-api-takumi.mihoyo.com/event/nap_cultivate_tool/user/avatar_calc?uid=${uid}&region=${region}`;
    let headers = {
      Cookie: finalCk,
      "Content-Type": "application/json",
      Referer: "https://act.mihoyo.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
      "x-rpc-platform": "4",
      "x-rpc-lang": "zh-cn",
      "x-rpc-device_id": crypto.randomUUID(),
      "x-rpc-device_fp": "38d8167aa7add",
      "x-rpc-cultivate_source": "pc",
      "x-rpc-is_teaser": "1",
      "x-rpc-page": "v2.6.1_apps-h_#",
    };

    let mergedData = new Map();
    let zzzDict = new Map();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let successCount = 0;

    // 🚨 串行发送独立请求
    for (let body of payloads) {
      let debugName = body._debug_name;
      delete body._debug_name;

      try {
        let res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }).then((r) => r.json());
        if (res?.retcode === 0 && res?.data) {
          successCount++;
          ["avatar_consume", "skill_consume", "weapon_consume"].forEach(
            (key) => {
              if (res.data[key]) {
                res.data[key].forEach((item) => {
                  let existing = zzzDict.get(String(item.id));
                  if (!existing)
                    existing = {
                      name: item.name,
                      icon: item.icon,
                      rarity: item.rarity,
                      src: new Set(),
                    };
                  existing.src.add(key);
                  zzzDict.set(String(item.id), existing);
                });
              }
            },
          );

          if (res.data.user_owns_materials) {
            for (let [id, num] of Object.entries(
              res.data.user_owns_materials,
            )) {
              mergedData.set(
                String(id),
                Math.max(mergedData.get(String(id)) || 0, Number(num)),
              );
            }
          }
        } else {
          console.error(`[绝区零背包] ❌ [${debugName}] 请求失败:`, res);
        }
      } catch (e) {
        console.error(`[绝区零背包] ❌ [${debugName}] 网络异常:`, e.message);
      }

      await sleep(200);
    }

    await this.e.reply(
      `[绝区零背包] 成功率: ${successCount}/${payloads.length}，抓取总数: ${mergedData.size} 种`,
    );

    const getDynamicTypeZzz = (name, srcSet) => {
      if (
        name.includes("丁尼") ||
        name.includes("记录") ||
        name.includes("模块") ||
        name.includes("电池") ||
        name.includes("涂剂")
      )
        return "exp";
      if (srcSet) {
        if (srcSet.has("skill_consume")) return "talent";
        if (srcSet.has("avatar_consume")) return "char";
        if (srcSet.has("weapon_consume")) return "weapon";
      }
      return "other";
    };

    const rarityMap = { S: 5, A: 4, B: 3, C: 2 };
    let ret = { length: 0 };

    for (let [id, num] of mergedData.entries()) {
      if (num <= 0) continue;
      let info = zzzDict.get(id);
      let name = info?.name || `未知材料(${id})`;
      let icon = info?.icon || "";
      let type = getDynamicTypeZzz(name, info?.src);
      let level = rarityMap[info?.rarity] || 1;

      ret[type] ||= [];
      ret[type].push({ id: Number(id), name, num, icon, type, level });
      ret.length++;
    }

    for (let i in ret) {
      if (Array.isArray(ret[i])) {
        ret[i].sort((a, b) => {
          let aTop = a.name === "丁尼" || a.name.includes("核心") ? 1 : 0;
          let bTop = b.name === "丁尼" || b.name.includes("核心") ? 1 : 0;
          if (aTop !== bTop) return bTop - aTop;
          return b.level - a.level || b.id - a.id;
        });
      }
    }
    return ret;
  }

  // ==================== 崩铁专属核心逻辑 ====================
  async fetchSrRawMaterials(uid, ck, region) {
    let silentE = { ...this.e, reply: () => {} };
    let fp = "38d8167aa7add";
    try {
      let fpRes = await MysInfo.get(silentE, "getFp");
      if (fpRes?.data?.device_fp) fp = fpRes.data.device_fp;
    } catch (e) {}

    let ckMap = {};
    ck.split(";").forEach((item) => {
      let i = item.indexOf("=");
      if (i > 0) {
        let k = item.substring(0, i).trim();
        let v = item.substring(i + 1).trim();
        if (k && v) ckMap[k] = v;
      }
    });

    delete ckMap["e_hkrpg_token"];

    try {
      let paths = [
        `${this._path}/plugins/xiaoyao-cvs-plugin/data/yaml/${this.e.user_id}.yaml`,
        `${this._path}/plugins/xhh/data/Stoken/${this.e.user_id}.yaml`,
      ];
      for (let p of paths) {
        if (fs.existsSync(p)) {
          let data = YAML.parse(fs.readFileSync(p, "utf8"));
          let item =
            data[uid] ||
            Object.values(data).find((v) => String(v.uid) === String(uid));
          if (item) {
            let yamlStoken =
              item.stoken || item.ck_stoken?.match(/stoken=([^;]+)/)?.[1] || "";
            let yamlStuid = item.stuid || item.ltuid || uid;
            let yamlMid =
              item.mid || item.ck_stoken?.match(/mid=([^;]+)/)?.[1] || "";

            if (yamlStoken && yamlStuid) {
              ckMap["stoken"] = yamlStoken;
              ckMap["stuid"] = yamlStuid;
              ckMap["account_id"] = yamlStuid;
              ckMap["account_id_v2"] = yamlStuid;
              if (yamlMid) {
                ckMap["mid"] = yamlMid;
                ckMap["account_mid_v2"] = yamlMid;
              }
              break;
            }
          }
        }
      }
    } catch (e) {
      console.error("[米游背包] 读取YAML失败", e);
    }

    let baseCk = Object.entries(ckMap)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    if (ckMap["stoken"] && ckMap["stuid"]) {
      try {
        let n = region.includes("official")
          ? "okr4obncj8bw5a65hbnn5oo6ixjc3l9w"
          : "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
        let t = Math.round(Date.now() / 1000);
        let r = Math.floor(Math.random() * 900000 + 100000);
        let b = JSON.stringify({
          uid: String(uid),
          region: region,
          game_biz: "hkrpg_cn",
          lang: "zh-cn",
        });
        let DS = crypto
          .createHash("md5")
          .update(`salt=${n}&t=${t}&r=${r}&b=${b}&q=`)
          .digest("hex");

        let rawRes = await fetch(
          `https://api-takumi.mihoyo.com/common/badge/v1/login/account`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: baseCk,
              "x-rpc-client_type": "5",
              "x-rpc-app_version": "2.44.1",
              DS: `${t},${r},${DS}`,
            },
            body: b,
          },
        );

        let resJson = await rawRes.json();
        if (resJson?.retcode === 0 && resJson?.data) {
          this.srRoleInfo = resJson.data;
        }

        let setCookiesStr = "";
        if (rawRes.headers.raw) {
          let sc = rawRes.headers.raw()["set-cookie"];
          if (sc) setCookiesStr = sc.join("; ");
        } else {
          setCookiesStr = rawRes.headers.get("set-cookie") || "";
        }

        let match = setCookiesStr.match(/e_hkrpg_token=([^;, ]+)/);
        if (match) ckMap["e_hkrpg_token"] = match[1];
      } catch (e) {}
    }

    let finalCk = Object.entries(ckMap)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    let webHeaders = {
      Cookie: finalCk,
      "Content-Type": "application/json",
      Referer: "https://act.mihoyo.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "x-rpc-lang": "zh-cn",
      "x-rpc-page": "v4.0.1__#/tools/calculation",
      "x-rpc-platform": "4",
      "x-rpc-view_source": "1",
      "x-rpc-device_fp": fp,
    };

    let query = `?game=hkrpg&game_biz=hkrpg_cn&badge_region=${region}&badge_uid=${uid}`;
    let payloads = [];

    try {
      let aUrl = `https://act-api-takumi.mihoyo.com/event/rpgcultivate/avatar/list${query}&page=1&size=999`;
      let aRes = await fetch(aUrl, { method: "GET", headers: webHeaders }).then(
        (r) => r.json(),
      );
      let aList = aRes?.data?.avatars || aRes?.data?.list || [];

      if (aList.length === 0) {
        [
          1001, 1002, 1003, 1004, 1005, 1008, 1009, 1102, 1204, 1302, 1404,
        ].forEach((id) => {
          payloads.push({
            game: "hkrpg",
            uid: String(uid),
            region,
            avatar: { item_id: String(id), cur_level: 1, target_level: 80 },
          });
        });
      } else {
        aList.forEach((a) => {
          let id = a.id || a.item_id || a.avatar_id;
          if (id) {
            let skill_list = [
              { item_id: String(id) + "002", cur_level: 1, target_level: 10 },
              { item_id: String(id) + "003", cur_level: 1, target_level: 10 },
              { item_id: String(id) + "004", cur_level: 1, target_level: 10 },
            ];
            payloads.push({
              game: "hkrpg",
              uid: String(uid),
              region,
              avatar: {
                item_id: String(id),
                cur_level: 1,
                target_level: a.max_level || 80,
              },
              skill_list: skill_list,
            });
          }
        });
      }

      let wUrl = `https://act-api-takumi.mihoyo.com/event/rpgcultivate/equipment/list${query}&page=1&size=999`;
      let wRes = await fetch(wUrl, { method: "GET", headers: webHeaders }).then(
        (r) => r.json(),
      );
      let wList = wRes?.data?.equipments || wRes?.data?.list || [];

      wList.forEach((w) => {
        let id = w.id || w.item_id || w.equipment_id;
        if (id)
          payloads.push({
            game: "hkrpg",
            uid: String(uid),
            region,
            equipment: {
              item_id: String(id),
              cur_level: 1,
              target_level: w.max_level || 80,
            },
          });
      });
    } catch (e) {
      console.error("获取崩铁图鉴失败", e);
    }

    console.log(`[米游背包] 成功组装崩铁测算载荷: ${payloads.length} 个`);

    let mergedData = new Map();
    let srDict = new Map();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let successCount = 0;

    for (let i = 0; i < payloads.length; i += 3) {
      let chunk = payloads.slice(i, i + 3);
      await Promise.all(
        chunk.map(async (body) => {
          try {
            let b = JSON.stringify(body);
            let n = region.includes("official")
              ? "okr4obncj8bw5a65hbnn5oo6ixjc3l9w"
              : "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
            let t = Math.round(Date.now() / 1000);
            let r = Math.floor(Math.random() * 900000 + 100000);
            let DS = crypto
              .createHash("md5")
              .update(`salt=${n}&t=${t}&r=${r}&b=${b}&q=`)
              .digest("hex");

            let appHeaders = {
              "Content-Type": "application/json",
              Cookie: finalCk,
              "x-rpc-client_type": "5",
              "x-rpc-app_version": "2.44.1",
              "x-rpc-device_fp": fp,
              DS: `${t},${r},${DS}`,
            };

            let res = await fetch(
              `https://act-api-takumi.mihoyo.com/event/rpgcultivate/calc/compute${query}`,
              {
                method: "POST",
                headers: appHeaders,
                body: b,
              },
            ).then((r) => r.json());

            if (res?.retcode === 0 && res.data) {
              successCount++;
              ["avatar_consume", "skill_consume", "equipment_consume"].forEach(
                (key) => {
                  if (res.data[key]) {
                    res.data[key].forEach((item) =>
                      srDict.set(String(item.item_id), {
                        name: item.item_name,
                        icon: item.item_url,
                        purpose: item.item_purpose || "",
                        rarity: item.rarity || 4, //抓取星级
                      }),
                    );
                  }
                },
              );

              if (res.data.user_owns_materials) {
                let owns = res.data.user_owns_materials;
                if (Array.isArray(owns)) {
                  owns.forEach((item) => {
                    let id = String(item.item_id || item.id);
                    let num = Number(item.num || item.count || 0);
                    mergedData.set(id, Math.max(mergedData.get(id) || 0, num));
                  });
                } else {
                  for (let [id, num] of Object.entries(owns)) {
                    mergedData.set(
                      String(id),
                      Math.max(mergedData.get(String(id)) || 0, Number(num)),
                    );
                  }
                }
              }
            }
          } catch (e) {}
        }),
      );
      await sleep(125);
    }
    await this.e.reply(
      `[崩铁背包] 成功率: ${successCount}/${payloads.length}，抓取总数: ${mergedData.size} 种`,
    );

    const getDynamicTypeSr = (name, purpose = "") => {
      if (purpose) {
        // 1. 光锥晋阶 + 行迹 -> 专属行迹材料
        if (purpose.includes("行迹材料") && purpose.includes("光锥晋阶"))
          return "material";

        // 2. 角色晋阶 + 行迹 -> 普通小怪掉落
        if (purpose.includes("行迹材料") && purpose.includes("角色晋阶"))
          return "normal";

        // 3. 纯角色晋阶 -> 凝滞虚影BOSS掉落
        if (purpose.includes("角色晋阶")) return "char";

        // 4. 纯行迹（命运的足迹、末日幻影BOSS掉落）
        if (purpose.includes("行迹材料")) return "talent";

        // 5. 基础材料
        if (
          name.includes("漫游指南") ||
          name.includes("以太") ||
          name.includes("信用点")
        )
          return "exp";
        return "other";
      }

      let meta = Material.get(name);
      if (meta?.type) {
        const typeMap = {
          char: "char",
          exp: "exp",
          material: "material",
          normal: "normal",
          other: "other",
          talent: "talent",
        };
        if (typeMap[meta.type]) return typeMap[meta.type];
      }

      return "other";
    };

    let ret = { length: 0 };
    for (let [id, num] of mergedData.entries()) {
      if (num <= 0) continue;
      let info = srDict.get(id);
      let name = info?.name || `未知材料(${id})`;
      let icon = info?.icon || "";
      let type = getDynamicTypeSr(name, info?.purpose);

      let level = Number(info?.rarity || 4); //读取星级

      ret[type] ||= [];
      ret[type].push({ id: Number(id), name, num, icon, type, level });
      ret.length++;
    }

    for (let i in ret) {
      if (Array.isArray(ret[i])) {
        ret[i].sort((a, b) => {
          let aTop = a.name === "信用点" || a.name === "命运的足迹" ? 1 : 0;
          let bTop = b.name === "信用点" || b.name === "命运的足迹" ? 1 : 0;
          if (aTop !== bTop) return bTop - aTop;
          return b.id - a.id;
        });
      }
    }
    return ret;
  }
}
