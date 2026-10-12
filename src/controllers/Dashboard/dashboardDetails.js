import { scholasticTypeNames } from "../../utils/scholasticTypes.js";
import { officePersonDetails } from '../../utils/officePersonDetails.js';
import { officeRecordWhere } from '../../utils/officeTypes.js';
import { scholasticVowsWhere } from '../../utils/scholasticVows.js';
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { JWT_SECRET } from "../../config/index.js";

const prisma = new PrismaClient();
const CARD_TYPES = new Set([
  "REGION", "DELEGATION", "MISSION", "PRIEST", "RELIGIOUS_BROTHER",
  "SCHOLASTIC_PERPETUAL", "SCHOLASTIC_TEMPORARY", "NOVICE",
  "MINOR_SEMINARIAN", "CENTER", "CURIA", "PCIC", "GCIC",
]);

const quickCodesByName = async (type, names) => {
  const rows = await prisma.quickcode_mst.findMany({
    where: { quick_code_type: type, quickcode_name: { in: names, mode: "insensitive" } },
    select: { quick_code: true },
  });
  return rows.map((row) => row.quick_code);
};

const getScope = async (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    const error = new Error("Authentication token is required.");
    error.status = 401;
    throw error;
  }

  const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
  const role = String(decoded.role_name || "").toLowerCase();
  const requestedProvince = req.body?.province_code;

  if (role === "province admin") {
    const province = await prisma.province_mst.findFirst({
      where: decoded.province_code
        ? { province_code: decoded.province_code }
        : { province_name: decoded.province_name },
      select: { province_code: true, province_name: true },
    });
    if (!province) {
      const error = new Error("Province scope was not found.");
      error.status = 403;
      throw error;
    }
    return { role, provinceCodes: [province.province_code], scopeLabel: province.province_name };
  }

  if (role === "congregation admin") {
    const provinceRows = await prisma.province_mst.findMany({
      where: {
        concretion_code: decoded.concretion_code,
        ...(requestedProvince && requestedProvince !== "ALL" ? { province_code: requestedProvince } : {}),
      },
      select: { province_code: true, province_name: true },
    });
    if (requestedProvince && requestedProvince !== "ALL" && provinceRows.length === 0) {
      const error = new Error("The selected province does not belong to your congregation.");
      error.status = 403;
      throw error;
    }
    let scopeLabel = provinceRows.length === 1 && requestedProvince && requestedProvince !== "ALL"
      ? provinceRows[0].province_name
      : "Congregation";
    if (scopeLabel === "Congregation") {
      const congregation = await prisma.concretion_defination_mst.findUnique({
        where: { concretion_code: decoded.concretion_code }, select: { concretion_name: true },
      });
      scopeLabel = congregation?.concretion_name || scopeLabel;
    }
    return { role, provinceCodes: provinceRows.map((row) => row.province_code), scopeLabel };
  }

  if (role === "super admin") {
    if (requestedProvince && requestedProvince !== "ALL") {
      const province = await prisma.province_mst.findUnique({
        where: { province_code: requestedProvince }, select: { province_code: true, province_name: true },
      });
      if (!province) {
        const error = new Error("Selected province was not found.");
        error.status = 404;
        throw error;
      }
      return { role, provinceCodes: [province.province_code], scopeLabel: province.province_name };
    }
    return { role, provinceCodes: null, scopeLabel: "ALL" };
  }

  const error = new Error("This role cannot access Dashboard details.");
  error.status = 403;
  throw error;
};

const provinceWhere = (provinceCodes) => provinceCodes ? { province_code: { in: provinceCodes } } : {};
const contains = (value) => ({ contains: value, mode: "insensitive" });
const mobileEquals = (search, field) => {
  if (!/^\d+$/.test(search)) return [];
  try { return [{ [field]: BigInt(search) }]; } catch { return []; }
};
const displayMobile = (number, isd) => {
  if (number === null || number === undefined) return "-";
  const prefix = isd ? `+${String(isd).replace(/^\+/, "")} ` : "";
  return `${prefix}${number.toString()}`;
};

const decorateProvinces = async (records) => {
  const codes = [...new Set(records.map((row) => row.province_code).filter(Boolean))];
  const provinces = await prisma.province_mst.findMany({
    where: { province_code: { in: codes } },
    select: { province_code: true, province_name: true },
  });
  const names = Object.fromEntries(provinces.map((row) => [row.province_code, row.province_name]));
  return records.map((row) => ({ ...row, province_name: names[row.province_code] || row.province_code }));
};

export const getDashboardDetails = async (req, res) => {
  try {
    const type = String(req.body?.type || "").toUpperCase();
    if (!CARD_TYPES.has(type)) return res.status(400).json({ message: "Invalid Dashboard detail type." });

    const { provinceCodes, scopeLabel: scopedLabel } = await getScope(req);
    const scopeLabel = ["PCIC", "GCIC"].includes(type) ? "ALL" : scopedLabel;
    const exportAll = req.body?.exportAll === true;
    const page = Math.max(Number.parseInt(req.body?.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(Number.parseInt(req.body?.pageSize, 10) || 50, 1), 100);
    const search = String(req.body?.search || "").trim();
    const skip = exportAll ? undefined : (page - 1) * pageSize;
    const take = exportAll ? undefined : pageSize;
    let where;
    let total;
    let filteredTotal;
    let records;
    let columns;
    let filterOptions;

    if (["CURIA", "PCIC", "GCIC"].includes(type)) {
      const people = await prisma.confreres_dtl.findMany({ where: { is_active: true, ...(type === "CURIA" ? provinceWhere(provinceCodes) : {}) }, select: { province_code: true, confrer_code: true, first_name: true, middle_name: true, last_name: true, personal1_isd: true, personal1_contact_no: true, personal_mailid1: true } });
      const baseWhere = type === "CURIA"
        ? { ...provinceWhere(provinceCodes), OR: people.map(person => ({ confrer_code: person.confrer_code, province_code: person.province_code })) }
        : await officeRecordWhere(prisma, type);
      const officeRows = await prisma.curia_advisors_dtl.findMany({
        where: baseWhere, select: { province_code: true, designation_code: true },
      });
      const [filterProvinces, filterDesignations] = await Promise.all([
        prisma.province_mst.findMany({ where: { province_code: { in: [...new Set(officeRows.map(row => row.province_code).filter(Boolean))] } }, select: { province_code: true, province_name: true } }),
        prisma.quickcode_mst.findMany({ where: { quick_code_type: 'destyp', quick_code: { in: [...new Set(officeRows.map(row => row.designation_code).filter(Boolean))] } }, select: { quick_code: true, quickcode_name: true } }),
      ]);
      filterOptions = {
        provinces: filterProvinces.map(row => ({ value: row.province_code, label: row.province_name })).sort((a, b) => a.label.localeCompare(b.label)),
        designations: filterDesignations.map(row => ({ value: row.quick_code, label: row.quickcode_name })).sort((a, b) => a.label.localeCompare(b.label)),
      };
      const names = Object.fromEntries(people.map(row => [row.confrer_code, [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ')]));
      where = { AND: [baseWhere,
        ...(req.body?.filterProvince ? [{ province_code: String(req.body.filterProvince) }] : []),
        ...(req.body?.filterDesignation ? [{ designation_code: String(req.body.filterDesignation) }] : []),
        ...(search ? [{ OR: [
        { confrer_code: { in: people.filter(row => [names[row.confrer_code], row.personal1_contact_no, row.personal_mailid1].some(value => String(value || '').toLowerCase().includes(search.toLowerCase()))).map(row => row.confrer_code) } },
        { personal_mailid1: contains(search) },
        ...mobileEquals(search, 'personal1_contact_no'),
      ] }] : [])] };
      [total, filteredTotal, records] = await Promise.all([
        prisma.curia_advisors_dtl.count({ where: baseWhere }), prisma.curia_advisors_dtl.count({ where }),
        prisma.curia_advisors_dtl.findMany({ where, select: { curia_code: true, confrer_code: true, province_code: true, division_type_code: true, division_code: true, pcic_off_code: true, gcic_off_code: true, designation_code: true, personal1_isd: true, personal1_contact_no: true }, orderBy: [{ province_code: 'asc' }, { curia_code: 'asc' }, { confrer_code: 'asc' }, { division_type_code: 'asc' }, { division_code: 'asc' }], skip, take }),
      ]);
      const designationCodes = [...new Set(records.map(row => row.designation_code).filter(Boolean))];
      const designations = designationCodes.length ? await prisma.quickcode_mst.findMany({
        where: { quick_code_type: 'destyp', quick_code: { in: designationCodes } },
        select: { quick_code: true, quickcode_name: true },
      }) : [];
      records = await Promise.all((await decorateProvinces(records)).map(async row => {
        const person = people.find(p => p.confrer_code === row.confrer_code && (type !== "CURIA" || p.province_code === row.province_code));
        const fallback = await officePersonDetails(prisma, person);
        return {
          ...row,
          name: type === "CURIA" ? [person?.first_name, person?.middle_name, person?.last_name].filter(Boolean).join(" ") : names[row.confrer_code],
          current_designations: designations.find(entry => entry.quick_code === row.designation_code)?.quickcode_name || fallback.current_designations,
          mobile_number: row.personal1_contact_no == null ? fallback.mobile_number : [row.personal1_isd, String(row.personal1_contact_no)].filter(Boolean).join(' '),
          personal1_contact_no: undefined,
        };
      }));
      columns = [{ title: 'Name', dataIndex: 'name' }, { title: 'Province', dataIndex: 'province_name' }, { title: 'Designation', dataIndex: 'current_designations' }, { title: 'Mobile Number', dataIndex: 'mobile_number' }];
    } else if (["REGION", "DELEGATION", "MISSION"].includes(type)) {
      const codes = await quickCodesByName("divtyp", [type]);
      const baseWhere = { ...provinceWhere(provinceCodes), division_type_code: { in: codes } };
      where = { ...baseWhere, ...(search ? { division_name: contains(search) } : {}) };
      [total, filteredTotal, records] = await Promise.all([
        prisma.division_setup_mst.count({ where: baseWhere }),
        prisma.division_setup_mst.count({ where }),
        prisma.division_setup_mst.findMany({ where, select: { division_type_code: true, division_code: true, division_name: true, province_code: true }, orderBy: { division_name: "asc" }, skip, take }),
      ]);
      records = await decorateProvinces(records);
      columns = [
        { title: `${type[0]}${type.slice(1).toLowerCase()} Name`, dataIndex: "division_name" },
        { title: "Province", dataIndex: "province_name" },
      ];
    } else if (["PRIEST", "RELIGIOUS_BROTHER"].includes(type)) {
      const memberName = type === "PRIEST" ? "priest" : "religious brother";
      const codes = await quickCodesByName("memtyp", [memberName]);
      const baseWhere = { ...provinceWhere(provinceCodes), member_type_code: { in: codes }, is_active: true };
      where = { ...baseWhere, ...(search ? { OR: [{ first_name: contains(search) }, { middle_name: contains(search) }, { last_name: contains(search) }, { personal_mailid1: contains(search) }, { personal1_contact_no: contains(search) }] } : {}) };
      [total, filteredTotal, records] = await Promise.all([
        prisma.confreres_dtl.count({ where: baseWhere }),
        prisma.confreres_dtl.count({ where }),
        prisma.confreres_dtl.findMany({ where, select: { confrer_code: true, first_name: true, middle_name: true, last_name: true, province_code: true, personal1_isd: true, personal1_contact_no: true, personal_mailid1: true }, orderBy: { first_name: "asc" }, skip, take }),
      ]);
      records = (await decorateProvinces(records)).map((row) => ({
        ...row,
        name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" "),
        mobile_number: displayMobile(row.personal1_contact_no, row.personal1_isd),
        personal1_contact_no: undefined,
      }));
      columns = [
        { title: "Name", dataIndex: "name" }, { title: "Province", dataIndex: "province_name" },
        { title: "Mobile Number", dataIndex: "mobile_number" }, { title: "Email", dataIndex: "personal_mailid1" },
      ];
    } else if (["SCHOLASTIC_PERPETUAL", "SCHOLASTIC_TEMPORARY"].includes(type)) {
      const baseWhere = scholasticVowsWhere(type, provinceWhere(provinceCodes));
      where = { ...baseWhere, ...(search ? { OR: [{ first_name: contains(search) }, { middle_name: contains(search) }, { last_name: contains(search) }, { personal_mailid1: contains(search) }, ...mobileEquals(search, "personal1_contact_no")] } : {}) };
      [total, filteredTotal, records] = await Promise.all([
        prisma.scholastics_dtl.count({ where: baseWhere }),
        prisma.scholastics_dtl.count({ where }),
        prisma.scholastics_dtl.findMany({ where, select: { scholastic_code: true, province_code: true, first_name: true, middle_name: true, last_name: true, personal1_isd: true, personal1_contact_no: true, personal_mailid1: true }, orderBy: [{ first_name: "asc" }, { scholastic_code: "asc" }, { province_code: "asc" }], skip, take }),
      ]);
      const admissions = records.length ? await prisma.scholastics_admisn_promon_dtl.findMany({
        where: { end_date: null, OR: records.map((row) => ({ scholastic_code: row.scholastic_code, province_code: row.province_code })) },
        select: { scholastic_code: true, province_code: true, centre_place: true },
        orderBy: { start_date: "desc" },
      }) : [];
      records = (await decorateProvinces(records)).map((row) => ({
        ...row,
        name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" "),
        mobile_number: displayMobile(row.personal1_contact_no, row.personal1_isd),
        personal1_contact_no: undefined,
        email: row.personal_mailid1 || "-",
        centre_place: admissions.find((entry) => entry.scholastic_code === row.scholastic_code && entry.province_code === row.province_code)?.centre_place || "-",
      }));
      columns = [
        { title: "Name", dataIndex: "name" }, { title: "Province", dataIndex: "province_name" },
        { title: "Mobile Number", dataIndex: "mobile_number" }, { title: "Email", dataIndex: "email" },
        { title: "Centre", dataIndex: "centre_place" },
      ];
    } else if (["NOVICE", "MINOR_SEMINARIAN"].includes(type)) {
      const codeField = "scholastic_type_code";
      const quickType = "schtyp";
      const codes = await quickCodesByName(quickType, scholasticTypeNames[type]);
      const baseWhere = { ...provinceWhere(provinceCodes), [codeField]: { in: codes }, end_date: null };
      const matchingScholastics = search ? await prisma.scholastics_dtl.findMany({
        where: { ...provinceWhere(provinceCodes), OR: [{ first_name: contains(search) }, { middle_name: contains(search) }, { last_name: contains(search) }, { personal_mailid1: contains(search) }, ...mobileEquals(search, "personal1_contact_no")] },
        select: { scholastic_code: true, province_code: true },
      }) : null;
      where = { ...baseWhere, ...(matchingScholastics ? { OR: matchingScholastics.map((row) => ({ scholastic_code: row.scholastic_code, province_code: row.province_code })) } : {}) };
      [total, filteredTotal, records] = await Promise.all([
        prisma.scholastics_admisn_promon_dtl.count({ where: baseWhere }),
        prisma.scholastics_admisn_promon_dtl.count({ where }),
        prisma.scholastics_admisn_promon_dtl.findMany({ where, select: { scholastics_admisn_code: true, scholastic_code: true, province_code: true, centre_place: true, promotion_date: true, start_date: true }, orderBy: { scholastic_code: "asc" }, skip, take }),
      ]);
      const scholasticCodes = [...new Set(records.map((row) => row.scholastic_code))];
      const people = await prisma.scholastics_dtl.findMany({ where: { ...provinceWhere(provinceCodes), scholastic_code: { in: scholasticCodes } }, select: { scholastic_code: true, province_code: true, first_name: true, middle_name: true, last_name: true, personal1_isd: true, personal1_contact_no: true, personal_mailid1: true } });
      const peopleMap = Object.fromEntries(people.map((row) => [`${row.province_code}:${row.scholastic_code}`, row]));
      records = (await decorateProvinces(records)).map((row) => {
        const person = peopleMap[`${row.province_code}:${row.scholastic_code}`];
        return {
          ...row,
          name: person ? [person.first_name, person.middle_name, person.last_name].filter(Boolean).join(" ") : "",
          mobile_number: person ? displayMobile(person.personal1_contact_no, person.personal1_isd) : "-",
          email: person?.personal_mailid1 || "-",
        };
      });
      columns = [
        { title: "Name", dataIndex: "name" }, { title: "Province", dataIndex: "province_name" },
        { title: "Mobile Number", dataIndex: "mobile_number" }, { title: "Email", dataIndex: "email" },
        { title: "Centre", dataIndex: "centre_place" },
      ];
    } else {
      const section = String(req.body?.section || "").trim();
      const centreType = String(req.body?.centreType || "").trim();
      if (!section || !centreType) return res.status(400).json({ message: "Center section and type are required." });
      const apostolateCodes = await quickCodesByName("apostl", [section]);
      const isDiocese = ["diocese", "diocse"].includes(centreType.toLowerCase());
      let centreTypeCodes = [];
      if (!isDiocese) {
        const mappings = await prisma.apostolates_mst.findMany({ where: { apostolate_code: { in: apostolateCodes }, centre_type_name: { equals: centreType, mode: "insensitive" }, ...provinceWhere(provinceCodes) }, select: { centre_type_code: true } });
        centreTypeCodes = [...new Set(mappings.map((row) => row.centre_type_code))];
      }
      const baseWhere = { ...provinceWhere(provinceCodes), apostolate_code: { in: apostolateCodes }, ...(isDiocese ? { diocese_code: { not: "" } } : { centre_type_code: { in: centreTypeCodes } }) };
      where = { ...baseWhere, ...(search ? { OR: [{ centre_name: contains(search) }, { centre_place: contains(search) }, { office_mailid1: contains(search) }, ...mobileEquals(search, "phone1_no")] } : {}) };
      [total, filteredTotal, records] = await Promise.all([
        prisma.centre_dtl.count({ where: baseWhere }), prisma.centre_dtl.count({ where }),
        prisma.centre_dtl.findMany({ where, select: { division_type_code: true, division_code: true, centre_code: true, centre_name: true, centre_place: true, province_code: true, diocese_code: true, phone1_isd: true, phone1_no: true, office_mailid1: true }, orderBy: { centre_name: "asc" }, skip, take }),
      ]);
      records = (await decorateProvinces(records)).map((row) => ({
        ...row,
        mobile_number: displayMobile(row.phone1_no, row.phone1_isd),
        phone1_no: undefined,
      }));
      columns = [
        { title: "Center Name", dataIndex: "centre_name" }, { title: "Place", dataIndex: "centre_place" },
        { title: "Province", dataIndex: "province_name" }, { title: "Mobile Number", dataIndex: "mobile_number" },
        { title: "Email", dataIndex: "office_mailid1" },
      ];
    }

    const searchPlaceholder = ["REGION", "DELEGATION", "MISSION"].includes(type)
      ? "Search by name"
      : "Search by name, mobile or email";
    res.json({ type, scopeLabel, total, filteredTotal, page, pageSize, totalPages: Math.max(Math.ceil(filteredTotal / pageSize), 1), searchPlaceholder, columns, records, filterOptions });
  } catch (error) {
    console.error("Dashboard detail error:", error);
    res.status(error.status || (error.name === "TokenExpiredError" ? 401 : 500)).json({ message: error.message || "Failed to load Dashboard details." });
  }
};
