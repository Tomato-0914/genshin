import base from "./base.js"
import MysInfo from "./mys/mysInfo.js"
import gsCfg from "./gsCfg.js"
import lodash from "lodash"
import { Character, Weapon } from "#miao.models"

export default class RoleBag extends base {
  constructor(e) {
    super(e)
    this.model = "roleBag"
  }

  static async get(e) {
    let roleBag = new RoleBag(e)
    return await roleBag.getData()
  }

  /** #角色背包 */
  async getData() {
    let res = await MysInfo.get(this.e, { index: "", character: "" })

    if (!res || res[0]?.retcode !== 0 || res[1]?.retcode !== 0) return false

    let [resIndex, resChar] = res
    let avatars = resChar.data.avatars || []

    if (avatars.length <= 0) {
      this.e.reply("暂无角色数据")
      return false
    }

    let role = resIndex.data.role || {}

    /** 截图数据 */
    let data = {
      ...this.screenData,
      saveId: this.e.uid,
      uid: this.e.uid,
      role: {
        nickname: role.nickname || this.e.sender?.card || this.e.sender?.nickname || "旅行者",
        level: role.level || "??",
        region: role.region_name || role.region || "",
        avatar: role.game_head_icon || role.AvatarUrl || "",
      },
      pluginName: "genshin",
      pluginVersion: false,
      ...this.dealData(avatars),
    }

    return data
  }

  dealData(avatars) {
    let type = "all"
    if (avatars.length > 8) {
      if (/(.*)(四星|4星)(.*)/.test(this.e.msg)) {
        type = 4
      }
      if (/(.*)(五星|5星)(.*)/.test(this.e.msg)) {
        type = 5
      }
    }

    let costumes = gsCfg.getdefSet("role", "other").costumes

    let list = []
    let count = { 5: 0, 4: 0 }

    for (let val of avatars) {
      let rarity = val.rarity > 5 ? 5 : val.rarity
      count[rarity] = (count[rarity] || 0) + 1

      if (type != "all" && rarity != type) {
        continue
      }

      let char = Character.get(val.id)
      if (!char) continue

      let sort =
        rarity * 100000 +
        val.actived_constellation_num * 10000 +
        val.level * 100 +
        (val.id - 10000000)

      // 增加神里排序
      if (val.id == 10000002) {
        sort += 50
      }

      if (val.rarity > 5) {
        sort = sort - (val.id - 10000000)
      }

      // 旅行者放最后
      if (char.isTraveler) {
        sort = 0
      }

      let weapon = Weapon.get(val.weapon?.name)

      let costume = false
      if (val.costumes && val.costumes.length >= 1) {
        costume = val.costumes.some(v => costumes.includes(v.name))
      }

      list.push({
        name: char.name,
        abbr: char.abbr,
        face: char.face,
        elem: char.elem,
        rarity,
        level: val.level,
        cons: val.actived_constellation_num,
        fetter: val.fetter,
        costume,
        weapon: {
          name: val.weapon?.name,
          icon: weapon?.icon || "",
          rarity: val.weapon?.rarity || 1,
          level: val.weapon?.level,
          affix: val.weapon?.affix_level || 1,
        },
        sort,
      })
    }

    list = lodash.orderBy(list, ["sort", "level"], ["desc", "desc"])

    let sections = []
    for (let star of [5, 4]) {
      let ds = list.filter(v => v.rarity == star)
      if (ds.length > 0) {
        sections.push({ title: `${star == 5 ? "五" : "四"}星角色`, star, list: ds })
      }
    }

    return { sections, num: list.length, count, total: avatars.length }
  }
}
