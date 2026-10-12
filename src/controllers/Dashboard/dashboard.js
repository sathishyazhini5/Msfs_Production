import { scholasticTypeNames, scholasticDashboardType } from "../../utils/scholasticTypes.js";
import { countScholasticVows } from '../../utils/scholasticVows.js';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/index.js";

// Get count of divisions by quick code
const validQuickcodeNames = ['Province', 'Region', 'Mission', 'Delegation'];

export const getDivisionCounts = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let province_code;

    // Step 1: Validate the Bearer token and extract province_code from the JWT
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      // Extract province_name from the decoded JWT
      const provinceName = decoded.province_name;

      const province = await prisma.province_mst.findFirst({
        where: { province_name: provinceName },
        select: { province_code: true },
      });

      if (!province) {
        return res.status(404).json({ error: "Province not found for the logged-in user" });
      }
      province_code = province.province_code;
    }

    // Step 2: If the province_code is not found from the token, return an error
    if (!province_code) {
      return res.status(400).json({ message: 'Province code is required.' });
    }

    // Define valid quickcode names
    const validQuickcodeNames = ["Province", "Region", "Mission", "Delegation"];

    // Fetch quick codes where quick_code_type is "divtyp" and quickcode_name is in validQuickcodeNames
    const quickCodes = await prisma.quickcode_mst.findMany({
      where: {
        province_code,
        quick_code_type: 'divtyp',
        quickcode_name: {
          in: validQuickcodeNames,
          mode: 'insensitive', // Case-insensitive matching
        },
      },
      select: {
        quick_code_type: true,
        quick_code: true,
        quickcode_name: true,
      },
    });

    // Ensure all valid quick codes are included in the result
    const allQuickCodes = validQuickcodeNames.map((name) => {
      const matchingQuickCode = quickCodes.find(
        (qc) => qc.quickcode_name.toLowerCase() === name.toLowerCase()
      );
      return {
        quick_code_type: 'divtyp',
        quick_code: matchingQuickCode ? matchingQuickCode.quick_code : null,
        quickcode_name: name,
      };
    });

    // Count divisions for each matching quick code in the division_setup_mst table
    const counts = await prisma.division_setup_mst.groupBy({
      by: ['division_type_code'],
      where: {
        province_code,
        division_type_code: { in: quickCodes.map((qc) => qc.quick_code) },
      },
      _count: { division_type_code: true },
    });

    // Map counts back to allQuickCodes
    const result = allQuickCodes.map((quickCode) => {
      const divisionCount = counts.find(
        (count) => count.division_type_code === quickCode.quick_code
      );
      return {
        [quickCode.quickcode_name]: divisionCount
          ? divisionCount._count.division_type_code
          : 0,
      };
    });

    // Flatten the result to match the required structure: Province: count, Region: count, etc.
    const formattedResponse = result.reduce((acc, item) => {
      const [key, value] = Object.entries(item)[0];
      acc[key] = value;
      return acc;
    }, {});

    // Return the formatted response
    res.json(formattedResponse);
  } catch (error) {
    console.error('Error fetching division counts:', error);
    res.status(500).json({ message: 'Failed to fetch division counts.' });
  }
};


  export const getDivisionCountsforDash = async (req, res) => {
    try {

      console.log(req.body)

      const { province_code } = req.body; // Extract province_code from request body

      // Step 1: Define valid quick code names
      const validQuickcodeNames = ['Region', 'Mission', 'Delegation'];

      // Step 2: Fetch quick codes from the quickcode_mst table
      const quickCodes = await prisma.quickcode_mst.findMany({
        where: {
          ...(province_code !== 'ALL' && { province_code }), // Filter by province_code if not "ALL"
          quick_code_type: 'divtyp',
          quickcode_name: {
            in: validQuickcodeNames,
            mode: 'insensitive', // Case-insensitive matching
          },
        },
        select: {
          quick_code: true, // Maps quickcode_name to division_type_code
          quickcode_name: true,
        },
      });

      // Step 3: Map validQuickcodeNames to ensure all are included
      const quickCodeMap = validQuickcodeNames.reduce((acc, name) => {
        const matchingCode = quickCodes.find(
          (qc) => qc.quickcode_name.toLowerCase() === name.toLowerCase()
        );
        acc[name] = matchingCode ? matchingCode.quick_code : null;
        return acc;
      }, {});

      // Step 4: Fetch counts from the division_setup_mst table
      const counts = await prisma.division_setup_mst.groupBy({
        by: ['division_type_code'],
        where: {
          ...(province_code !== 'ALL' && { province_code }), // Filter by province_code if not "ALL"
          division_type_code: { in: Object.values(quickCodeMap).filter(Boolean) }, // Only include valid division_type_codes
        },
        _count: { division_type_code: true },
      });

      // Step 5: Map counts back to validQuickcodeNames
      const result = validQuickcodeNames.reduce((acc, name) => {
        const matchingCount = counts.find(
          (count) => count.division_type_code === quickCodeMap[name]
        );
        acc[name] = matchingCount ? matchingCount._count.division_type_code : 0;
        return acc;
      }, {});

      // Return the formatted response
      res.json(result);
    } catch (error) {
      console.error('Error fetching division counts:', error);
      res.status(500).json({ message: 'Failed to fetch division counts.' });
    }
  }

  export const getDivisionCountsforTokenProvince = async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      let province_code;
      let role_name;
      let province_name;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        try {
          const decoded = jwt.verify(token, JWT_SECRET);

          role_name = decoded.role_name.trim().toLowerCase();
          province_name = decoded.province_name;

          if (role_name === "super admin") {
            // ALL is a login scope, not a province record.
            province_code = "ALL";
          } else if (province_name) {
            const province = await prisma.province_mst.findFirst({
              where: { province_name: province_name },
              select: { province_code: true },
            });

            if (!province) {
              return res.status(404).json({ error: "Province not found" });
            }
            province_code = province.province_code;
          }
        } catch (error) {
          if (error.name === "TokenExpiredError") {
            return res.status(401).json({ error: "JWT token has expired" });
          }
          throw error;
        }
      }

      if (req.body.province_code) {
        province_code = req.body.province_code;
      }

      if (!role_name) {
        return res.status(403).json({ error: "Role name not found in token." });
      }

      const validQuickcodeNames = ["Province", "Region", "Mission", "Delegation"];
      const validQuickcodes = await prisma.quickcode_mst.findMany({
        where: {
          quick_code_type: "divtyp",
          quickcode_name: { in: validQuickcodeNames, mode: "insensitive" },
        },
        select: {
          quick_code: true,
          quickcode_name: true,
        },
      });

      let divisionCounts = [];
      if (role_name === "super admin" && province_code && province_code !== "ALL") {
        divisionCounts = await prisma.division_setup_mst.groupBy({
          by: ["division_type_code"],
          where: {
            province_code,
            division_type_code: { in: validQuickcodes.map((q) => q.quick_code) },
          },
          _count: { division_type_code: true },
        });
      } else if (role_name === "province admin") {
        if (!province_code) {
          return res.status(400).json({ error: "Province code is required." });
        }
        divisionCounts = await prisma.division_setup_mst.groupBy({
          by: ["division_type_code"],
          where: {
            province_code,
            division_type_code: { in: validQuickcodes.map((q) => q.quick_code) },
          },
          _count: { division_type_code: true },
        });
      } else if (role_name === "super admin") {
        divisionCounts = await prisma.division_setup_mst.groupBy({
          by: ["division_type_code"],
          where: {
            division_type_code: { in: validQuickcodes.map((q) => q.quick_code) },
          },
          _count: { division_type_code: true },
        });
      }

      const vowsCounts = await countScholasticVows(
        prisma,
        province_code && province_code !== "ALL" ? { province_code } : {},
      );

      // Fetch quick codes for member types
      const memberTypeQuickcodes = await prisma.quickcode_mst.findMany({
        where: {
          quick_code_type: "memtyp",
          quickcode_name: { in: ["priest", "religious brother"], mode: "insensitive" },
        },
        select: {
          quick_code: true,
          quickcode_name: true,
        },
      });

      // Map quick_code to quickcode_name (lowercased for case insensitivity)
      const quickcodeMap = Object.fromEntries(
        memberTypeQuickcodes.map((q) => [q.quick_code.toLowerCase(), q.quickcode_name.toLowerCase()])
      );

      // Count confreres by member type code
      const memberTypeCounts = {
        priest: 0,
        "religious brother": 0, // Enclosed the key in quotes
    };


      const counts = await prisma.confreres_dtl.groupBy({
        by: ["member_type_code"],
        where: {
          ...(province_code && province_code !== "ALL" ? { province_code } : {}), // Apply province filter only if a specific province is selected
          member_type_code: { in: Object.keys(quickcodeMap) },
          is_active: true,
        },
        _count: { member_type_code: true },
      });

      // Aggregate the counts for each member type
      counts.forEach((count) => {
        const quickcodeName = quickcodeMap[count.member_type_code.toLowerCase()]; // Map member_type_code to its quickcode_name
        if (quickcodeName === "priest") {
          memberTypeCounts.priest += count._count.member_type_code;
        } else if (quickcodeName === "religious brother") {
          memberTypeCounts["religious brother"] += count._count.member_type_code;

        }
      });

      const scholasticTypeQuickcodes = await prisma.quickcode_mst.findMany({
        where: {
          quick_code_type: "schtyp",
          quickcode_name: { in: [...scholasticTypeNames.NOVICE, ...scholasticTypeNames.MINOR_SEMINARIAN], mode: "insensitive" },
        },
        select: {
          quick_code: true,
          quickcode_name: true,
        },
      });


      const scholasticTypeMap = Object.fromEntries(
        scholasticTypeQuickcodes.map((q) => [q.quick_code.toLowerCase(), scholasticDashboardType(q.quickcode_name)])
      );

      // Initialize counts for "novices" and "minor seminarians"
      const scholasticTypeCounts = {
        novoices: 0,
        minor_seminarians: 0,
      };

      // Count "novices" and "minor seminarians"
      const scholasticCounts = await prisma.scholastics_admisn_promon_dtl.groupBy({
        by: ["scholastic_type_code"],
        where: {
          ...(province_code && province_code !== "ALL" ? { province_code } : {}),
          scholastic_type_code: { in: Object.keys(scholasticTypeMap), mode: "insensitive" },
          end_date: null,
        },
        _count: { scholastic_type_code: true },
      });

      scholasticCounts.forEach((count) => {
        const quickcodeName = scholasticTypeMap[count.scholastic_type_code.toLowerCase()];
        if (quickcodeName === "novoices") {
          scholasticTypeCounts.novoices += count._count.scholastic_type_code;
        } else if (quickcodeName === "minor seminarians") {
          scholasticTypeCounts.minor_seminarians += count._count.scholastic_type_code;
        }
      });


      const apostolateQuickcodes = await prisma.quickcode_mst.findMany({
        where: {
          quick_code_type: "apostl",
          quickcode_name: { in: ["Mission", "Formation", "Education", "SAIM"], mode: "insensitive" },
        },
        select: {
          quick_code: true,
          quickcode_name: true,
        },
      });

      const apostolateTypeMap = Object.fromEntries(
        apostolateQuickcodes.map((q) => [q.quick_code.toLowerCase(), q.quickcode_name.toLowerCase()])
      );

      // Initialize result structure
      const apostolateCounts = {};

      // Fetch apostolates for the valid types
      const apostolates = await prisma.apostolates_mst.findMany({
        where: {
          ...(province_code && province_code !== "ALL" ? { province_code } : {}),
          apostolate_code: { in: Object.keys(apostolateTypeMap) },
        },
        select: {
          apostolate_code: true,
          centre_type_code: true,
          centre_type_name: true,
        },
      });

      const centreScope = {
        ...(province_code && province_code !== "ALL" ? { province_code } : {}),
      };
      const [centreTypeCounts, dioceseCounts] = await Promise.all([
        prisma.centre_dtl.groupBy({
          by: ["apostolate_code", "centre_type_code"],
          where: centreScope,
          _count: { centre_code: true },
        }),
        prisma.centre_dtl.groupBy({
          by: ["apostolate_code"],
          where: { ...centreScope, diocese_code: { not: "" } },
          _count: { centre_code: true },
        }),
      ]);

      const processedCentreCombinations = new Set();
      const processedDioceseApostolates = new Set();

      // Process every distinct apostolate/centre-type combination exactly once.
      for (const apostolate of apostolates) {
        const apostolateType = apostolateTypeMap[apostolate.apostolate_code.toLowerCase()];
        if (!apostolateType) continue;

        if (!apostolateCounts[apostolateType]) {
          apostolateCounts[apostolateType] = {};
        }

        const centreCombinationKey = `${apostolate.apostolate_code}:${apostolate.centre_type_code}`;
        if (!processedCentreCombinations.has(centreCombinationKey)) {
          processedCentreCombinations.add(centreCombinationKey);
          const centreCount = centreTypeCounts.find((count) =>
            count.apostolate_code === apostolate.apostolate_code &&
            count.centre_type_code === apostolate.centre_type_code
          )?._count.centre_code || 0;

          if (centreCount >= 1) {
            apostolateCounts[apostolateType][apostolate.centre_type_name] =
              (apostolateCounts[apostolateType][apostolate.centre_type_name] || 0) + centreCount;
          }
        }

        if (!processedDioceseApostolates.has(apostolate.apostolate_code)) {
          processedDioceseApostolates.add(apostolate.apostolate_code);
          const dioceseCount = dioceseCounts.find((count) =>
            count.apostolate_code === apostolate.apostolate_code
          )?._count.centre_code || 0;
          apostolateCounts[apostolateType].diocese =
            (apostolateCounts[apostolateType].diocese || 0) + dioceseCount;
        }
      }

      const aggregatedCounts = validQuickcodeNames.reduce((acc, name) => {
        const quickCodesForName = validQuickcodes
          .filter((q) => q.quickcode_name.toLowerCase() === name.toLowerCase())
          .map((q) => q.quick_code);

        const totalCount = divisionCounts
          .filter((dc) => quickCodesForName.includes(dc.division_type_code))
          .reduce((sum, dc) => sum + dc._count.division_type_code, 0);

        acc[name] = totalCount;
        return acc;
      }, {});

      const reorderedApostolateCounts = Object.keys(apostolateCounts).reduce((acc, key) => {
        const { diocese, ...rest } = apostolateCounts[key]; // Extract diocese separately
        acc[key] = { ...rest, Diocese: diocese }; // Place diocese at the end
        return acc;
    }, {});
    

      res.json({
        province_code,
        province_name: province_name || "ALL",
        role_name,
        firstProfessionCount: vowsCounts.firstProfessionCount, // Updated
        finalProfessionCount: vowsCounts.finalProfessionCount,
        ...memberTypeCounts,
        ...scholasticTypeCounts,
        ...apostolateCounts,
        ...reorderedApostolateCounts,
        ...aggregatedCounts,
      });
    } catch (error) {
      console.error("Error fetching division counts:", error);
      res.status(500).json({ message: "Failed to fetch division counts." });
    }
  };










